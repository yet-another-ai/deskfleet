import type { CentralApi, Machine } from "./central.ts"
import { browserMuxPeer, type MuxPeerFactory } from "./mux-peer.ts"
import { connectMachineMux, type ConnectedMux, type MuxTarget } from "./mux-signaling.ts"
import { MUX_PROFILE, type MuxPurpose } from "./mux/protocol.ts"
import type { MuxStream } from "./mux/connection.ts"
import { PEER_SETUP_TIMEOUT_MS } from "./peer-lifecycle.ts"

export type { MuxPeerFactory, MuxPeer, MuxPeerEvents } from "./mux-peer.ts"
export type { MuxTarget } from "./mux-signaling.ts"
export const supportsMachineMux = (machine: Pick<Machine, "capabilities">): boolean =>
  machine.capabilities.mux === MUX_PROFILE && machine.capabilities.muxServer === MUX_PROFILE
const keyOf = (target: MuxTarget) => JSON.stringify([target.teamId, target.machineId])

/** The authenticated central client owns transport lifetime, independent of individual views. */
export class MachineMuxRegistry {
  readonly #central: CentralApi
  readonly #factory: MuxPeerFactory
  readonly #known = new Map<string, boolean>()
  readonly #unsupported = new Set<string>()
  readonly #rosters = new Map<string, Promise<void>>()
  readonly #peers = new Map<string, Promise<ConnectedMux | undefined>>()
  readonly #unsubscribe: () => void
  #scope = new AbortController()
  #closed = false

  constructor(central: CentralApi, factory: MuxPeerFactory) {
    this.#central = central; this.#factory = factory
    this.#unsubscribe = central.onEvent(event => {
      if (event.type === "accountChanged") void this.#reset()
      else if (event.type === "machinesChanged") {
        for (const key of this.#known.keys()) if ((JSON.parse(key) as string[])[0] === event.teamId) {
          this.#known.delete(key); this.#unsupported.delete(key)
        }
      }
    })
  }
  observe(machine: Machine): void {
    const key = keyOf({ teamId: machine.teamId, machineId: machine.id })
    if (!this.#closed && !this.#unsupported.has(key)) this.#known.set(key, supportsMachineMux(machine))
  }

  async #supports(target: MuxTarget, scope: AbortController): Promise<boolean> {
    const key = keyOf(target), cached = this.#known.get(key)
    if (cached !== undefined) return cached
    let loading = this.#rosters.get(target.teamId)
    if (!loading) {
      loading = this.#central.machines(target.teamId).then(machines => {
        if (scope !== this.#scope) return
        this.#known.set(key, false)
        for (const machine of machines) this.observe(machine)
      }).finally(() => { if (this.#rosters.get(target.teamId) === loading) this.#rosters.delete(target.teamId) })
      this.#rosters.set(target.teamId, loading)
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => finish(new Error("Machine account changed"))
      const timer = setTimeout(() => finish(new Error("Machine capability lookup timed out")), PEER_SETUP_TIMEOUT_MS)
      const finish = (error?: unknown) => {
        clearTimeout(timer); scope.signal.removeEventListener("abort", abort)
        if (error) reject(error); else resolve()
      }
      scope.signal.addEventListener("abort", abort, { once: true })
      void loading.then(() => finish(), finish)
      if (scope.signal.aborted) abort()
    })
    return this.#known.get(key) === true
  }

  async open(target: MuxTarget, purpose: MuxPurpose): Promise<MuxStream | undefined> {
    if (this.#closed) throw new Error("Machine transports are closed")
    const scope = this.#scope, key = keyOf(target)
    let pending = this.#peers.get(key)
    if (!pending) {
      pending = (async () => {
        const supported = await this.#supports(target, scope)
        if (scope.signal.aborted) throw new Error("Machine account changed")
        if (!supported) return undefined
        const connected = await connectMachineMux(this.#central, target, this.#factory, scope.signal, () => {
          if (this.#peers.get(key) === pending) this.#peers.delete(key)
        })
        if (!connected && scope === this.#scope) { this.#known.set(key, false); this.#unsupported.add(key) }
        return connected
      })()
      this.#peers.set(key, pending)
      void pending.then(value => { if (!value && this.#peers.get(key) === pending) this.#peers.delete(key) }, () => {
        if (this.#peers.get(key) === pending) this.#peers.delete(key)
      })
    }
    const peer = await pending
    if (scope.signal.aborted) throw new Error("Machine account changed")
    if (!peer) return undefined
    const stream = peer.connection.open(purpose)
    const abort = () => stream.close(new Error("Machine account changed"))
    scope.signal.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(() => stream.close(new Error("Mux stream opening timed out")), PEER_SETUP_TIMEOUT_MS)
    try {
      await stream.ready
      if (scope.signal.aborted || stream.state === "closed") throw stream.error ?? new Error("Mux stream closed")
      return stream
    } finally { clearTimeout(timer); scope.signal.removeEventListener("abort", abort) }
  }
  async #reset(): Promise<void> {
    this.#scope.abort(); this.#scope = new AbortController()
    const peers = [...this.#peers.values()]
    this.#peers.clear(); this.#known.clear(); this.#unsupported.clear(); this.#rosters.clear()
    // Abort tears down immediately; late grant/factory results clean themselves up.
    await Promise.allSettled(peers.map(async pending => (await pending)?.close()))
  }
  async close(): Promise<void> { this.#closed = true; this.#unsubscribe(); await this.#reset() }
}

const registries = new WeakMap<CentralApi, Map<MuxPeerFactory, MachineMuxRegistry>>()
export function getMachineMux(central: CentralApi, factory: MuxPeerFactory = browserMuxPeer): MachineMuxRegistry {
  let hosts = registries.get(central)
  if (!hosts) { hosts = new Map(); registries.set(central, hosts) }
  let registry = hosts.get(factory)
  if (!registry) { registry = new MachineMuxRegistry(central, factory); hosts.set(factory, registry) }
  return registry
}
