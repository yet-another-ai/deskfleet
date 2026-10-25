import type { ProviderDisplaySnapshot } from "./providers.ts"
import type { CatalogSnapshot } from "./catalog.ts"
import type { AgentEvent, AgentSnapshot } from "../../../apps/daemon/src/agent-protocol.ts"
import type { DesktopEvent, IceCandidate } from "./desktop-media.ts"
import type { User, Team as WireTeam, Machine as WireMachine, PeerAuthorization, ControlMessage } from "../../../crates/protocol/control.ts"

export type AccountUser = Omit<User, "email"> & { email?: User["email"] }
export interface AccountState { serverUrl: string; user?: AccountUser }
export type Team = Omit<WireTeam, "role"> & { role: "admin" | "member" }
export interface TeamMember { userId: string; name: string; email?: string | null; role: "admin" | "member" }
export type Machine = Omit<WireMachine, "capabilities" | "lastSeenAt"> & { capabilities: Record<string, unknown>; lastSeenAt?: WireMachine["lastSeenAt"] }
export interface LocalEnrollment {
  configured: boolean; connected: boolean; revoked: boolean; serverUrl?: string; machineId?: string; teamId?: string
  identity: { originId: string; machineId: string }; machineName: string
}
export interface PeerGrant { peerId: string; authorization: PeerAuthorization; iceServers: RTCIceServer[] }
export type CentralEvent =
  | { type: "peerEvent"; peerId: string; event: Omit<DesktopEvent, "sessionId"> }
  | Extract<ControlMessage, { type: "peerRevoked" | "catalogChanged" | "machinesChanged" | "presence" }>
  | { type: "connection"; connected: boolean }
  | { type: "accountChanged" }

/** Explicit control-plane operations, shared by browser and the narrow Electron bridge. */
export interface CentralApi {
  status(): Promise<AccountState>
  setServer(serverUrl: string): Promise<AccountState>
  login(): Promise<void>
  logout(): Promise<void>
  teams(): Promise<Team[]>
  createTeam(name: string): Promise<Team>
  members(teamId: string): Promise<TeamMember[]>
  renameTeam(teamId: string, name: string): Promise<Team>
  invite(teamId: string, email: string, role: "admin" | "member"): Promise<{ token: string; expiresAt: string }>
  acceptInvite(token: string): Promise<Team>
  setMemberRole(teamId: string, userId: string, role: "admin" | "member"): Promise<void>
  removeMember(teamId: string, userId: string): Promise<void>
  machines(teamId: string): Promise<Machine[]>
  /** Any Team member can rename a machine; its daemon's hostname is unchanged. */
  renameMachine(machineId: string, name: string): Promise<Machine>
  /** Administrator removal revokes the machine's credential and its live peers. */
  removeMachine(machineId: string): Promise<void>
  enrollHeadless(teamId: string, machine: { name: string; originId: string; localMachineId: string }): Promise<{ machine: Machine; token: string }>
  localEnrollment?(): Promise<LocalEnrollment>
  /** The name defaults to this computer's hostname. */
  enrollLocal?(teamId: string, name?: string): Promise<LocalEnrollment>
  catalog(machineId: string): Promise<{ machineId: string; snapshot: CatalogSnapshot; lastObservedAt: string; providers?: ProviderDisplaySnapshot }>
  sessions(machineId: string): Promise<AgentSnapshot[]>
  session(machineId: string, sessionId: string): Promise<{ snapshot: AgentSnapshot; lastEventSeq: string; lastObservedAt: string }>
  events(machineId: string, sessionId: string, after: string, limit: number): Promise<{ events: AgentEvent[]; lastEventSeq: string }>
  rpc<T = unknown>(machineId: string, method: string, params: unknown): Promise<T>
  createPeer(teamId: string, machineId: string, purpose: "agent" | "terminal" | "desktop" | "files"): Promise<PeerGrant>
  offerPeer(peerId: string, sdp: string, options?: unknown): Promise<{ sdp: string }>
  startPeer(peerId: string, options: { displayId: number }): Promise<void>
  candidatePeer(peerId: string, candidate: IceCandidate): Promise<void>
  closePeer(peerId: string): Promise<void>
  onEvent(listener: (event: CentralEvent) => void): () => void
}
