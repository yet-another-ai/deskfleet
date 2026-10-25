import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { AgentProviders } from "./agent-providers.ts"
import { AgentSessions } from "./agent-sessions.ts"
import type { AgentProvider } from "./agents/acp.ts"
import { DaemonCatalog } from "./catalog.ts"
import { CentralClient } from "./central-client.ts"
import type { CentralStatus } from "./central-protocol.ts"
import type { DesktopCapabilities } from "./control-protocol.ts"
import type { ControlPeers } from "./control-server.ts"
import { activeMachineDirectory, newMachineDirectory } from "./machine-directory.ts"
import { MachineOperations } from "./machine-operations.ts"
import { TerminalSessions } from "./terminals.ts"

interface MachineOptions {
  peers: ControlPeers
  capabilities: () => Promise<DesktopCapabilities>
  agentProvider?: AgentProvider
  terminals?: TerminalSessions
  allowLocalControlForTests?: boolean
}

async function openMachine(directory: string, options: MachineOptions) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const catalog = new DaemonCatalog(directory)
  const providers = new AgentProviders(directory, options.agentProvider)
  const terminals = options.terminals ?? new TerminalSessions({ directory: join(directory, "terminals") })
  let agents: AgentSessions | undefined
  let central: CentralClient | undefined
  let stopping: Promise<void> | undefined
  let closing: Promise<void> | undefined
  const stop = () => stopping ??= (async () => {
    // Providers must close before awaiting a create/configure RPC they can unblock.
    const results = await Promise.allSettled([central?.stop(), agents?.close(), terminals.close()])
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, "Failed to stop machine resources")
  })()
  const close = () => closing ??= (async () => {
    try { await stop() }
    finally {
      try { await central?.close() }
      finally { await catalog.close() }
    }
  })()
  try {
    await catalog.init()
    catalog.onSessionRelease(worktreeId => terminals.hangupOwned(worktreeId))
    await providers.init()
    agents = new AgentSessions(catalog, catalog.native, options.agentProvider, providers)
    await agents.init()
    await terminals.init()
    agents.onSessionArchive(worktreeId => terminals.stopOwned(worktreeId))
    const operations = new MachineOperations({ agents, catalog, providers, terminals, capabilities: options.capabilities })
    central = new CentralClient(directory, operations, options.peers)
    await central.init()
    return { directory, catalog, providers, agents, terminals, central, stop, close }
  } catch (error) {
    try { await close() }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Machine startup and cleanup failed", { cause: error }) }
    throw error
  }
}

type Machine = Awaited<ReturnType<typeof openMachine>>

/** Host IPC survives replacing a revoked registration's entire execution context. */
export class MachineRuntime {
  readonly #directory: string
  readonly #options: MachineOptions
  #machine: Machine | undefined
  #preparing: Promise<CentralStatus> | undefined
  #stopping: Promise<void> | undefined
  #closing: Promise<void> | undefined

  constructor(directory: string, options: MachineOptions) { this.#directory = directory; this.#options = options }

  get current(): Machine {
    if (!this.#machine) throw new Error("Machine service is not ready")
    return this.#machine
  }

  /** The caller owns discovery before selecting and opening the active directory. */
  async init(): Promise<void> {
    const directory = this.#options.allowLocalControlForTests ? this.#directory : await activeMachineDirectory(this.#directory)
    this.#machine = await openMachine(directory, this.#options)
  }

  prepareEnrollment(): Promise<CentralStatus> {
    if (this.#stopping) return Promise.reject(new Error("Machine service is stopping"))
    if (this.#preparing) return this.#preparing
    const status = this.current.central.status()
    if (!status.configured) return Promise.resolve(status)
    if (!status.revoked) return Promise.reject(new Error("This machine is already enrolled"))
    this.#preparing = (async () => {
      const previous = this.current
      const directory = await newMachineDirectory(this.#directory)
      const next = await openMachine(directory.path, { ...this.#options, terminals: undefined })
      try {
        await previous.stop()
        await directory.activate()
      }
      catch (error) { await next.close(); throw error }
      this.#machine = next
      await previous.close().catch(error => console.error("Retired machine cleanup failed", error))
      return next.central.status()
    })().finally(() => { this.#preparing = undefined })
    return this.#preparing
  }

  stop(): Promise<void> {
    return this.#stopping ??= (async () => {
      // An accepted reset finishes before host shutdown closes the new context.
      await this.#preparing?.catch(() => {})
      await this.#machine?.stop()
    })()
  }

  close(): Promise<void> {
    return this.#closing ??= (async () => {
      try { await this.stop() }
      finally { await this.#machine?.close() }
    })()
  }
}
