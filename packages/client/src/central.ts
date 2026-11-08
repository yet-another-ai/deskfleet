import type { RelayDeniedReason } from "./relay.ts"
import type { PeerTelemetryEvent } from "./peer-telemetry.ts"
import type { ProviderDisplaySnapshot } from "./providers.ts"
import type { BillingInterval, TeamBilling, AdminTeamBillingPage, AdminTeamBillingQuery } from "./billing.ts"
import type { AiUsageQuery, TeamAiUsage, TeamAiUsageSessions } from "./ai-usage.ts"
import type { ScheduleSnapshot, SearchPage, SearchQuery } from "./search.ts"
import type { CatalogSnapshot } from "./catalog.ts"
import type { AgentEvent, AgentSnapshot } from "../../../apps/daemon/src/agent-protocol.ts"
import type { DesktopEvent, DesktopStart, IceCandidate, VideoCodec } from "./desktop-media.ts"
import type { User, Team as WireTeam, Machine as WireMachine, PeerAuthorization, ControlMessage, SiteSettings, TurnSettings, CloudflareTurnSettings, CloudflareTurnSettingsUpdate, TeamTurnSettings, TeamTurnSettingsUpdate } from "../../../crates/protocol/control.ts"

export type AccountUser = Omit<User, "email"> & { email?: User["email"] }
export interface GithubAppSettings { configured: boolean; manageUrl: string | null; authorized: boolean; login: string | null; actAsYou: boolean }
export interface GithubPullRequestQuery { owner: string; repo: string; branch: string; headOwner?: string }
export interface GithubPullRequest { number: number; title: string; url: string; state: "draft" | "open" | "merged" | "closed" }
export interface AccountState { serverUrl: string; user?: AccountUser; siteAdmin: boolean }
export type { SiteSettings, TurnSettings, CloudflareTurnSettings, CloudflareTurnSettingsUpdate, TeamTurnAvailability, TeamTurnSettings, TeamTurnSettingsUpdate } from "../../../crates/protocol/control.ts"
export type TeamRole = "owner" | "admin" | "member"
export type Team = Omit<WireTeam, "role"> & { role: TeamRole }
export interface TeamMember { userId: string; name: string; email?: string | null; role: TeamRole }
export interface TeamUsage { relayedBytes: string; activeSessionCount: number; memberCount: number }
export type Machine = Omit<WireMachine, "capabilities" | "lastSeenAt"> & { capabilities: Record<string, unknown>; lastSeenAt?: WireMachine["lastSeenAt"] }
export interface LocalEnrollment {
  configured: boolean; connected: boolean; revoked: boolean; serverUrl?: string; machineId?: string; teamId?: string
  identity: { originId: string; machineId: string }; machineName: string
}
export interface LocalMachineStatus { machineName: string; registrations: LocalEnrollment[] }
export interface MachineEnrollmentRequest { name: string; originId: string; localMachineId: string; identityToken: string }
export interface PeerGrant { peerId: string; authorization: PeerAuthorization; iceServers: RTCIceServer[]; relayDeniedReason?: RelayDeniedReason | null }
/** Media preferences only; SDP belongs in the offer body and session IDs stay local. */
export interface PeerOfferOptions { codec?: VideoCodec; audio?: boolean }
/** Capture settings for an already authorized desktop peer. */
export type PeerStartOptions = Omit<DesktopStart, "sessionId">
/** Kept in Electron main; the one-use token binds a grant to a local IPC connection. */
export interface LocalPeerGrant { peerId: string; authorization: PeerAuthorization; token: string }
/** List and notification state without conversation content or request payloads. */
export interface AgentSessionSummary {
  session: AgentSnapshot["session"]
  turns: Array<Pick<AgentSnapshot["turns"][number], "id" | "state" | "endedAt">>
  permissions: Array<Pick<AgentSnapshot["permissions"][number], "id" | "state" | "createdAt">>
  elicitations: Array<Pick<AgentSnapshot["elicitations"][number], "id" | "state" | "createdAt">>
}
export type CentralEvent =
  | { type: "peerTelemetry"; event: PeerTelemetryEvent }
  | { type: "peerEvent"; peerId: string; event: Omit<DesktopEvent, "sessionId"> }
  | Extract<ControlMessage, { type: "peerRevoked" | "catalogChanged" | "machinesChanged" | "presence" }>
  | { type: "connection"; connected: boolean }
  | { type: "accountChanged" }

/** Site management is available to the Web host, separately from the desktop bridge. */
export interface SiteAdministrationApi {
  siteSettings(): Promise<SiteSettings>
  updateSiteSettings(settings: SiteSettings): Promise<SiteSettings>
  turnSettings(): Promise<TurnSettings>
  updateTurnSettings(settings: TurnSettings): Promise<TurnSettings>
  cloudflareTurnSettings(): Promise<CloudflareTurnSettings>
  updateCloudflareTurnSettings(settings: CloudflareTurnSettingsUpdate): Promise<CloudflareTurnSettings>
  billingTeams(query?: AdminTeamBillingQuery): Promise<AdminTeamBillingPage>
  setManualGrant(teamId: string, plan: "free" | "go" | "pro" | "enterprise" | null, expiresAt: number | null, reason: string): Promise<void>
  registrationPolicy(): Promise<{ registrationEnabled: boolean }>
  updateRegistration(enabled: boolean): Promise<void>
  users(query: string): Promise<Array<{ id: string; name: string; email: string; disabled: boolean }>>
  disableUser(userId: string, disabled: boolean): Promise<void>
  /** Confirms recent authentication with a password, or a Passkey when omitted. */
  reauthenticate(password?: string): Promise<void>
  sendEmailCode(): Promise<{ challengeId: string; expiresIn: number; retryAfter: number }>
  verifyEmailCode(challengeId: string, code: string): Promise<void>
  authenticationMethods(): Promise<import("./account-security.ts").AuthenticationMethods>
}

/** Explicit control-plane operations, shared by browser and the narrow Electron bridge. */
export interface CentralApi {
  status(): Promise<AccountState>
  login(): Promise<void>
  logout(): Promise<void>
  openAccountSettings(): Promise<void>
  githubSettings(): Promise<GithubAppSettings>
  manageGithub(): Promise<void>
  authorizeGithubApp(): Promise<void>
  setGithubActAsYou(enabled: boolean): Promise<GithubAppSettings>
  githubPullRequest(query: GithubPullRequestQuery): Promise<{ pullRequest: GithubPullRequest | null }>
  billing(teamId: string): Promise<TeamBilling>
  checkout(teamId: string, plan: "go" | "pro", requestId: string, interval?: BillingInterval): Promise<void>
  billingPortal(teamId: string): Promise<void>
  site(): Promise<SiteSettings>
  teams(): Promise<Team[]>
  createTeam(name: string): Promise<Team>
  members(teamId: string): Promise<TeamMember[]>
  teamUsage(teamId: string): Promise<TeamUsage>
  /** Team owners and administrators; the shared secret is write-only. */
  teamTurnSettings(teamId: string): Promise<TeamTurnSettings>
  /** Omit `secret` to keep the stored one; an empty URL list removes the server. */
  updateTeamTurnSettings(teamId: string, settings: TeamTurnSettingsUpdate): Promise<TeamTurnSettings>
  aiUsage(teamId: string, query: AiUsageQuery): Promise<TeamAiUsage>
  aiUsageSessions(teamId: string, query: { date: string; timeZone: string }): Promise<TeamAiUsageSessions>
  search(teamId: string, query: SearchQuery): Promise<SearchPage>
  scheduleSnapshot(teamId: string, machineId: string): Promise<ScheduleSnapshot>
  renameTeam(teamId: string, name: string): Promise<Team>
  invite(teamId: string, email: string, role: "admin" | "member"): Promise<{ token: string; expiresAt: string }>
  acceptInvite(token: string): Promise<Team>
  setMemberRole(teamId: string, userId: string, role: "admin" | "member"): Promise<void>
  removeMember(teamId: string, userId: string): Promise<void>
  transferOwnership(teamId: string, userId: string): Promise<void>
  machines(teamId: string): Promise<Machine[]>
  /** Any Team member can rename a machine; its daemon's hostname is unchanged. */
  renameMachine(teamId: string, machineId: string, name: string): Promise<Machine>
  /** Administrator removal revokes the machine's credential and its live peers. */
  removeMachine(teamId: string, machineId: string): Promise<void>
  enrollHeadless(teamId: string, machine: MachineEnrollmentRequest): Promise<{ machine: Machine; token: string }>
  localEnrollment?(): Promise<LocalMachineStatus>
  /** The name defaults to this computer's hostname. */
  enrollLocal?(teamId: string, name?: string): Promise<LocalEnrollment>
  catalog(teamId: string, machineId: string): Promise<{ machineId: string; snapshot: CatalogSnapshot; lastObservedAt: string; providers?: ProviderDisplaySnapshot }>
  sessions(teamId: string, machineId: string, sessionId?: string): Promise<AgentSessionSummary[]>
  session(teamId: string, machineId: string, sessionId: string): Promise<{ snapshot: AgentSnapshot; lastEventSeq: string; lastObservedAt: string }>
  events(teamId: string, machineId: string, sessionId: string, after: string, limit: number): Promise<{ events: AgentEvent[]; lastEventSeq: string }>
  rpc<T = unknown>(teamId: string, machineId: string, method: string, params: unknown): Promise<T>
  createPeer(teamId: string, machineId: string, purpose: "agent" | "terminal" | "desktop" | "files" | "ports" | "mux"): Promise<PeerGrant>
  offerPeer(peerId: string, sdp: string, options?: PeerOfferOptions): Promise<{ sdp: string }>
  startPeer(peerId: string, options: PeerStartOptions): Promise<void>
  candidatePeer(peerId: string, candidate: IceCandidate): Promise<void>
  closePeer(peerId: string): Promise<void>
  onEvent(listener: (event: CentralEvent) => void): () => void
}
