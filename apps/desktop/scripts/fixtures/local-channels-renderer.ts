import type { DeskfleetDesktopApi } from "../../../../packages/client/src/desktop-api.ts"
import { remoteMachineClient } from "../../../../packages/client/src/remote.ts"
import { AgentClient, type AgentNotification } from "../../../../packages/components/src/services/agent-client.ts"
import { TerminalClient } from "../../../../packages/components/src/services/terminal-client.ts"
import type { AgentSnapshot } from "../../../daemon/src/agent-protocol.ts"
import type { GitStatusSnapshot } from "../../../daemon/src/git-protocol.ts"

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
async function until(predicate: () => boolean, description: string): Promise<void> {
  const end = Date.now() + 20_000
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`Local message channel smoke timed out: ${description}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const rounded = (value: number) => Math.round(value * 100) / 100

/** Real renderer clients use the shipped preload, main-process authority and daemon IPC. */
export async function exercise(context: { teamId: string; machineId: string; sessionId: string }) {
  const host = (window as unknown as { deskfleet: DeskfleetDesktopApi }).deskfleet
  const guard = (window as unknown as { __deskfleetRtcGuard: { blocked: boolean; forbiddenAttempts: number; connections: number } }).__deskfleetRtcGuard
  require(host.central && host.localChannels, "The production preload must expose local message channels")
  const central = host.central
  const machine = (await central.machines(context.teamId)).find(value => value.id === context.machineId)
  require(machine, "Local machine registration is missing")
  guard.blocked = true
  const local = remoteMachineClient(host, central, machine, { local: true })
  const notifications: AgentNotification[] = []
  const agent = new AgentClient(local.api.agent, () => {}, event => notifications.push(event))
  let terminal: TerminalClient | undefined
  let terminalId: string | undefined
  try {
    await agent.call("initialize", { protocolVersion: 1 })
    const snapshot = await agent.call<AgentSnapshot>("_deskfleet/session/subscribe", { sessionId: context.sessionId })
    const inputs = snapshot.inputs.map(value => value.id)
    require(inputs.length > 0, "The existing UI prompt must have been accepted")
    const git = await agent.call<GitStatusSnapshot>("_deskfleet/git/status", { sessionId: context.sessionId })
    require(git.repositories[0]?.head, "Git status must read the real fixture repository")
    const branches = await agent.call<{ branches: string[] }>("_deskfleet/git/branches", { workspaceId: snapshot.session.workspaceId })
    require(branches.branches.length > 0, "Git branches must return over the local Agent channel")
    await agent.call("_deskfleet/git/subscribe", { sessionId: context.sessionId, subscriptionId: "local-smoke" })

    terminalId = crypto.randomUUID()
    await local.api.terminal.dial({ mode: "create", terminalId, cols: 80, rows: 24, cwd: git.repositories[0]!.root })
    let output = ""
    let ready = false
    terminal = new TerminalClient(local.api.terminal, () => {}, event => {
      if (event.kind === "output") output += atob(event.data)
      if (event.kind === "ready") ready = true
    })
    await terminal.call("attach", { sessionId: terminalId })
    await until(() => ready, "initial terminal replay")
    // Split the output marker so shell echo alone cannot satisfy the assertion.
    const command = host.platform === "win32"
      ? "Set-Content -Path direct-channel-smoke.txt -Value local-channel; Write-Output ('DF_' + 'LOCAL_READY')\r"
      : "printf 'local-channel\\n' > direct-channel-smoke.txt; printf 'DF_%s_READY\\n' LOCAL\r"
    await terminal.input(terminalId, command)
    await until(() => output.includes("DF_LOCAL_READY"), "PTY command output with RTCPeerConnection disabled")
    await until(() => notifications.some(event => event.method === "_deskfleet/git/changed"), "live Git invalidation")
    const changed = await agent.call<GitStatusSnapshot>("_deskfleet/git/status", { sessionId: context.sessionId, force: true })
    require(changed.repositories.some(repository => repository.changes.some(change => change.path === "direct-channel-smoke.txt")), "Git status must expose the terminal's real file change")
    await terminal.call("resize", { sessionId: terminalId, cols: 100, rows: 30 })
    terminal.close()
    const retained = (await local.api.terminal.list()).find(value => value.id === terminalId)
    require(retained?.status === "running" && retained.cols === 100 && retained.rows === 30, "Closing the local channel must preserve the resized shell")
    output = ""; ready = false
    terminal = new TerminalClient(local.api.terminal, () => {}, event => {
      if (event.kind === "output") output += atob(event.data)
      if (event.kind === "ready") ready = true
    })
    await terminal.call("attach", { sessionId: terminalId })
    await until(() => ready && output.includes("DF_LOCAL_READY"), "terminal replay after local reconnect")
    agent.close()
    await agent.call("initialize", { protocolVersion: 1 })
    const reattached = await agent.call<AgentSnapshot>("_deskfleet/session/subscribe", { sessionId: context.sessionId })
    require(JSON.stringify(reattached.inputs.map(value => value.id)) === JSON.stringify(inputs), "Reattachment must preserve accepted inputs without submitting them again")
    require(guard.forbiddenAttempts === 0, "Local interactions attempted to construct a PeerConnection")
    terminal.close(); agent.close()

    // Compare the same production Agent client and same daemon with only its adapter changed.
    const timings: { transport: string; setupMs: number; rpcMedianMs: number; rpcP95Ms: number; samples: number }[] = []
    for (const direct of [true, false, true, false]) {
      guard.blocked = direct
      const adapter = remoteMachineClient(host, central, machine, { local: direct })
      const measured = new AgentClient(adapter.api.agent, () => {}, () => {})
      try {
        const start = performance.now()
        await measured.call("initialize", { protocolVersion: 1 })
        const setupMs = performance.now() - start
        const samples: number[] = []
        for (let index = 0; index < 20; index++) {
          const start = performance.now()
          await measured.call("_deskfleet/session/subscribe", { sessionId: context.sessionId })
          samples.push(performance.now() - start)
        }
        samples.sort((a, b) => a - b)
        timings.push({ transport: direct ? "local" : "webrtc", setupMs: rounded(setupMs), rpcMedianMs: rounded(samples[10]!), rpcP95Ms: rounded(samples[18]!), samples: samples.length })
      } finally { measured.close(); adapter.dispose() }
    }
    guard.blocked = true
    require(guard.forbiddenAttempts === 0, "Local timing samples attempted WebRTC")
    return { webRtcDisabled: true, gitReadAndInvalidation: true, terminalInputResizeAndReplay: true, acceptedInputsPreserved: inputs.length, timings }
  } finally {
    guard.blocked = true
    terminal?.close(); agent.close(); local.dispose()
    if (terminalId) await central.rpc(context.machineId, "terminalHangup", { terminalId })
  }
}
