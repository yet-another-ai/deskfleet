import { relayFailureMessage, type RelayDeniedReason } from "./relay.ts"
import { observePeerGrant, type PeerConnectionTelemetry } from "./peer-telemetry.ts"
import type { DeskfleetDesktopApi } from "./desktop-api.ts"
import type { CentralApi, CentralEvent, Machine } from "./central.ts"
import type { DesktopEvent, DesktopOffer, DesktopStart, IceCandidate } from "./desktop-media.ts"
import type { TerminalOffer } from "../../../apps/daemon/src/control-protocol.ts"
import type { AgentMethod, AgentMethods } from "../../../apps/daemon/src/agent-protocol.ts"
import type { TerminalSummary } from "./terminal.ts"
import { LocalDataChannel } from "./local-channels.ts"

interface Peer { id: string; relayDeniedReason?: RelayDeniedReason | null; timer: ReturnType<typeof setTimeout>; telemetry: PeerConnectionTelemetry }
const management = new Set<string>([
  "_deskfleet/agent/configuration", "_deskfleet/session/configuration", "_deskfleet/session/configure",
  "_deskfleet/session/create", "_deskfleet/session/fork", "_deskfleet/session/archive", "_deskfleet/session/restore", "_deskfleet/session/rename", "_deskfleet/command/get",
  "_deskfleet/git/branches",
])

/** One opened machine owns this adapter until its account/Team scope is released. */
export function remoteMachineClient(host: DeskfleetDesktopApi, central: CentralApi, machine: Machine, options: { local?: boolean } = {}): { api: DeskfleetDesktopApi; refreshCatalog(): void; updateMachine(value: Machine): void; setLocal(local: boolean): void; dispose(): void } {
  let local = options.local === true && host.platform !== "web"
  const localChannels = new Map<string, LocalDataChannel>()
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
  function refreshCatalog(sessionId?: string): void {
    for (const listener of catalogEvents) listener(sessionId)
    if (!sessionId) for (const listener of providerEvents) listener()
  }
  const unsubscribe = central.onEvent((event: CentralEvent) => {
    if (event.type === "peerEvent" || event.type === "peerRevoked") {
      const local = [...peers.entries()].find(([, peer]) => peer.id === event.peerId)
      if (!local) return
      if (event.type === "peerEvent") {
        if (event.event.kind === "stateChanged" && "state" in event.event) {
          const state = String(event.event.state).toLowerCase()
          if (state === "connected") local[1].telemetry.connected()
          else if (state === "failed") local[1].telemetry.failed()
        } else if (event.event.kind === "error") local[1].telemetry.failed()
        emit({ ...event.event, sessionId: local[0] } as DesktopEvent)
      }
      else emit({ sessionId: local[0], kind: "error", error: event.reason })
    } else if ((event.type === "catalogChanged" && event.machineId === machine.id) || (event.type === "connection" && event.connected)) {
      // Reconnect can miss catalog updates even when the machine's roster metadata is unchanged.
      refreshCatalog(event.type === "catalogChanged" ? event.sessionId : undefined)
    } else if (event.type === "presence" && event.machineId === machine.id) {
      online = event.online
      for (const listener of catalogEvents) listener()
    }
  })
  const connectChannel = (purpose: "agent" | "terminal") => (sessionId: string) => {
    if (disposed) throw new Error("Machine connection was closed")
    if (!host.localChannels) throw new Error("Local message channels are unavailable")
    const channel = new LocalDataChannel(host.localChannels, { connectionId: sessionId, teamId: machine.teamId, machineId: machine.id, purpose })
    localChannels.set(sessionId, channel)
    channel.addEventListener("close", () => { localChannels.delete(sessionId) }, { once: true })
    return channel
  }
  const signaling = (purpose: "agent" | "terminal" | "desktop") => ({
    ...(local && purpose !== "desktop" ? { connectChannel: connectChannel(purpose) } : {}),
    async prepare(sessionId: string): Promise<RTCIceServer[]> {
      const grant = await central.createPeer(machine.teamId, machine.id, purpose)
      if (disposed) { await central.closePeer(grant.peerId); throw new Error("Machine connection was closed") }
      const expiresAt = Date.parse(grant.authorization.expiresAt)
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        await central.closePeer(grant.peerId)
        throw new Error("Peer authorization has expired")
      }
      const timer = setTimeout(() => emit({ sessionId, kind: "error", error: "Peer authorization has expired. Reconnect to continue." }), expiresAt - Date.now())
      peers.set(sessionId, { id: grant.peerId, timer, relayDeniedReason: grant.relayDeniedReason, telemetry: observePeerGrant(purpose, grant, machine.teamId) })
      return grant.iceServers
    },
    connectionFailure: (sessionId: string) => relayFailureMessage(peers.get(sessionId)?.relayDeniedReason),
    async offer(options: TerminalOffer | DesktopOffer): Promise<{ sdp: string }> {
      const peer = peers.get(options.sessionId)
      if (!peer) throw new Error("Peer authorization is missing")
      try { return await central.offerPeer(peer.id, options.sdp, options) }
      catch (error) { peer.telemetry.failed(); throw error }
    },
    async candidate(sessionId: string, candidate: IceCandidate): Promise<void> {
      const peer = peers.get(sessionId)
      if (!peer) throw new Error("Peer authorization is missing")
      await central.candidatePeer(peer.id, candidate)
    },
    async close(sessionId: string): Promise<void> {
      const channel = localChannels.get(sessionId)
      if (channel) { channel.close(); return }
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
    target: { id: machine.id, local, lastSeen: machine.lastSeenAt ?? undefined },
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
      control: <M extends AgentMethod>(method: M, params: AgentMethods[M]["params"]) => management.has(method) && !(local && method === "_deskfleet/git/branches") ? rpc<AgentMethods[M]["result"]>(method, params) : undefined,
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
  return {
    api,
    refreshCatalog,
    // A refreshed roster repairs presence events missed during signaling loss,
    // without replacing the adapter or revoking its still-authorized peers.
    updateMachine(value) {
      const lastSeen = value.lastSeenAt ?? undefined
      if (online === value.online && name === value.name && api.target!.lastSeen === lastSeen) return
      online = value.online
      name = value.name
      api.target!.lastSeen = lastSeen
      for (const listener of catalogEvents) listener()
    },
    // The surface detaches its viewers first; management subscriptions and caches stay in place.
    setLocal(value) {
      local = value && host.platform !== "web"
      api.target!.local = local
      api.agent.connectChannel = local ? connectChannel("agent") : undefined
      api.terminal.connectChannel = local ? connectChannel("terminal") : undefined
    },
    dispose() { disposed = true; unsubscribe(); for (const channel of localChannels.values()) channel.close(); for (const [id] of peers) void api.agent.close(id).catch(() => {}); events.clear(); catalogEvents.clear(); providerEvents.clear() },
  }
}
