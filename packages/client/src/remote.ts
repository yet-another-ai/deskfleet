import { relayFailureMessage, type RelayDeniedReason } from "./relay.ts"
import type { DeskfleetDesktopApi } from "./desktop-api.ts"
import type { CentralApi, CentralEvent, Machine } from "./central.ts"
import type { DesktopEvent, DesktopOffer, DesktopStart, IceCandidate } from "./desktop-media.ts"
import type { TerminalOffer } from "../../../apps/daemon/src/control-protocol.ts"
import type { AgentMethod, AgentMethods } from "../../../apps/daemon/src/agent-protocol.ts"
import type { TerminalSummary } from "./terminal.ts"

interface Peer { id: string; relayDeniedReason?: RelayDeniedReason | null; timer: ReturnType<typeof setTimeout> }
const management = new Set<string>([
  "_deskfleet/agent/configuration", "_deskfleet/session/configuration", "_deskfleet/session/configure",
  "_deskfleet/session/create", "_deskfleet/session/fork", "_deskfleet/session/archive", "_deskfleet/session/restore", "_deskfleet/session/rename", "_deskfleet/command/get",
])

/** One selected machine owns this adapter; the host replaces its Pinia scope on target changes. */
export function remoteMachineClient(host: DeskfleetDesktopApi, central: CentralApi, machine: Machine): { api: DeskfleetDesktopApi; dispose(): void } {
  const peers = new Map<string, Peer>()
  const events = new Set<(event: DesktopEvent) => void>()
  const catalogEvents = new Set<(sessionId?: string) => void>()
  const providerEvents = new Set<() => void>()
  let disposed = false
  let online = machine.online
  // The central catalog carries the Team's current name for the machine, including later renames.
  let name = machine.name
  let knownTerminals: TerminalSummary[] = []
  const emit = (event: DesktopEvent) => { for (const listener of events) listener(event) }
  const unsubscribe = central.onEvent((event: CentralEvent) => {
    if (event.type === "peerEvent" || event.type === "peerRevoked") {
      const local = [...peers.entries()].find(([, peer]) => peer.id === event.peerId)
      if (!local) return
      if (event.type === "peerEvent") emit({ ...event.event, sessionId: local[0] } as DesktopEvent)
      else emit({ sessionId: local[0], kind: "error", error: event.reason })
    } else if (event.type === "catalogChanged" && event.machineId === machine.id) {
      for (const listener of catalogEvents) listener(event.sessionId)
      if (!event.sessionId) for (const listener of providerEvents) listener()
    } else if (event.type === "presence" && event.machineId === machine.id) {
      online = event.online
      for (const listener of catalogEvents) listener()
    }
  })
  const signaling = (purpose: "agent" | "terminal" | "desktop") => ({
    async prepare(sessionId: string): Promise<RTCIceServer[]> {
      const grant = await central.createPeer(machine.teamId, machine.id, purpose)
      if (disposed) { await central.closePeer(grant.peerId); throw new Error("Machine connection was closed") }
      const expiresAt = Date.parse(grant.authorization.expiresAt)
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        await central.closePeer(grant.peerId)
        throw new Error("Peer authorization has expired")
      }
      const timer = setTimeout(() => emit({ sessionId, kind: "error", error: "Peer authorization has expired. Reconnect to continue." }), expiresAt - Date.now())
      peers.set(sessionId, { id: grant.peerId, timer, relayDeniedReason: grant.relayDeniedReason })
      return grant.iceServers
    },
    connectionFailure: (sessionId: string) => relayFailureMessage(peers.get(sessionId)?.relayDeniedReason),
    async offer(options: TerminalOffer | DesktopOffer): Promise<{ sdp: string }> {
      const peer = peers.get(options.sessionId)
      if (!peer) throw new Error("Peer authorization is missing")
      return central.offerPeer(peer.id, options.sdp, options)
    },
    async candidate(sessionId: string, candidate: IceCandidate): Promise<void> {
      const peer = peers.get(sessionId)
      if (!peer) throw new Error("Peer authorization is missing")
      await central.candidatePeer(peer.id, candidate)
    },
    async close(sessionId: string): Promise<void> {
      const peer = peers.get(sessionId)
      if (!peer) return
      peers.delete(sessionId); clearTimeout(peer.timer)
      await central.closePeer(peer.id)
    },
    onEvent(listener: (event: DesktopEvent) => void) { events.add(listener); return () => { events.delete(listener) } },
  })
  const rpc = <T>(method: string, params: unknown = {}) => central.rpc<T>(machine.id, method, params)
  const api: DeskfleetDesktopApi = {
    ...host,
    target: { id: machine.id, local: false, lastSeen: machine.lastSeenAt ?? undefined },
    catalog: {
      list: async () => {
        const { snapshot } = await central.catalog(machine.id)
        name = snapshot.machineName
        return snapshot
      },
      createWorkspace: (name, directories) => rpc("workspaceCreate", { name, directories }),
      updateWorkspace: (workspaceId, name, directories) => rpc("workspaceUpdate", { workspaceId, name, directories }),
      deleteWorkspace: workspaceId => rpc("workspaceDelete", { workspaceId }),
      onChanged: listener => { catalogEvents.add(listener); return () => { catalogEvents.delete(listener) } },
    },
    filesystem: { listDirectories: path => rpc("directoryList", path === undefined ? {} : { path }) },
    system: { status: () => rpc("systemStatus") },
    providers: {
      display: async () => (await central.catalog(machine.id)).providers ?? { providers: [] },
      list: () => rpc("providerList"), create: provider => rpc("providerCreate", { provider }),
      update: (providerId, changes) => rpc("providerUpdate", { providerId, changes }),
      remove: providerId => rpc("providerRemove", { providerId }), test: provider => rpc("providerTest", { provider }),
      probe: provider => rpc("providerProbe", { provider }),
      install: provider => rpc("providerInstall", { provider }), login: provider => rpc("providerLogin", { provider }),
      onChanged: listener => { providerEvents.add(listener); return () => { providerEvents.delete(listener) } },
    },
    agent: {
      ...signaling("agent"),
      control: <M extends AgentMethod>(method: M, params: AgentMethods[M]["params"]) => management.has(method) ? rpc<AgentMethods[M]["result"]>(method, params) : undefined,
      history: {
        available: () => online,
        list: async () => (await central.sessions(machine.id)).map(snapshot => snapshot.session),
        snapshot: async sessionId => (await central.session(machine.id, sessionId)).snapshot,
        events: async (sessionId, after, limit) => (await central.events(machine.id, sessionId, after, limit)).events,
      },
    },
    terminal: {
      ...signaling("terminal"), list: async () => online ? (knownTerminals = await rpc("terminalList")) : knownTerminals,
      dial: options => rpc("terminalDial", options), hangup: terminalId => rpc("terminalHangup", { terminalId }),
      onSessionEvent: () => () => {},
    },
    desktop: {
      ...signaling("desktop"),
      target: async () => {
        // Enrollment precedes the daemon's first capability report. Read the
        // current record so discovery also sees later capture-permission changes.
        const current = (await central.machines(machine.teamId)).find(value => value.id === machine.id)
        if (!current) throw new Error("Machine is no longer available in this team")
        return { id: machine.id, name, online, desktop: current.capabilities.desktop === true }
      },
      capabilities: () => rpc("capabilities"),
      start: (options: DesktopStart) => {
        const peer = peers.get(options.sessionId)
        if (!peer) return Promise.reject(new Error("Peer authorization is missing"))
        return central.startPeer(peer.id, { displayId: options.displayId, ...(options.control ? { control: true } : {}) })
      },
    },
  }
  return { api, dispose() { disposed = true; unsubscribe(); for (const [id] of peers) void api.agent.close(id).catch(() => {}); events.clear(); catalogEvents.clear(); providerEvents.clear() } }
}
