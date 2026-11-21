import type { ProviderDisplaySnapshot } from "./providers.ts"
import type { AdminPlanQuota, GithubRepositoryItemsPage, GithubRepositoryItemsQuery, PeerStartOptions } from "./central.ts"
import type { AccountState, AccountUser, AdminAccount, CreateAccountInput, GithubAppSettings, GithubPullRequest, GithubPullRequestQuery, AgentSessionSummary, CentralApi, CentralEvent, LocalPeerGrant, Machine, PeerGrant, PeerOfferOptions, PushSubscriptionInput, SiteAdministrationApi, SiteSettings, TelemetryConsentUpdate, TurnSettings, CloudflareTurnSettings, CloudflareTurnSettingsUpdate, Team, TeamMember, TeamTurnSettings, TeamTurnSettingsUpdate, TeamUsage } from "./central.ts"
import type { CatalogSnapshot } from "./catalog.ts"
import type { AgentEvent, AgentSnapshot } from "../../../apps/daemon/src/agent-protocol.ts"
import type { IceCandidate } from "./desktop-media.ts"
import type { BillingInterval, CreditRates, HostedPlan, PlanQuota, TeamBilling, AdminTeamBillingPage, AdminTeamBillingQuery } from "./billing.ts"
import type { AccountDeletionRequestPage, AccountDeletionRequestQuery } from "./account-deletion.ts"
import type { AiUsageQuery, TeamAiUsage, TeamAiUsageSessions } from "./ai-usage.ts"
import { readSuperAgentHistory, superAgentPath, type SuperAgentSession, type SuperAgentHistory, type SuperAgentMessageContent, type SuperAgentUsage } from "./super-agent.ts"
import type { SiteUsagePeriod, SiteUsageTrends } from "./site-usage.ts"
import type { ScheduleSnapshot, SearchPage, SearchQuery } from "./search.ts"
import { authenticatePasskey } from "./passkeys.ts"
import { apiRequest, API_RETRY_STATUS_CODES, type ApiRequestOptions } from "./api-request.ts"
import { HttpError } from "./request-diagnostics.ts"
import { APP_FOREGROUND_EVENT } from "./app-foreground.ts"
import type { CentralSocket, CentralTransport } from "./central-transport.ts"
import type { Machine as WireMachine, NetworkConfiguration } from "../../../crates/protocol/control.ts"

export { HttpError } from "./request-diagnostics.ts"

const HEARTBEAT_MS = 20_000
const IDLE_TIMEOUT_MS = 60_000
/** WebSocket close only requests a handshake; a dead peer never answers and no deadline exists. */
const CLOSE_GRACE_MS = 2_000
const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 30_000
/** Resume probes replace a socket only when the link misses this round trip. */
const PROBE_TIMEOUT_MS = 10_000

interface RecoveryRoster {
  controller: AbortController
  promise: Promise<Machine[]>
  reject: (error: Error) => void
}

function recovering(): Error { return new Error("Connection is recovering. Try again once reconnected.") }

type SocketMessage = CentralEvent | { type: "ready" } | { type: "ping" } | { type: "pong" }

/** Enrollment can precede the daemon's first capability report. */
function machineFromWire(machine: WireMachine): Machine {
  const capabilities = machine.capabilities
  return { ...machine, capabilities: capabilities !== null && typeof capabilities === "object" && !Array.isArray(capabilities)
    ? capabilities as Record<string, unknown> : {} }
}

export interface SavedAccount { serverUrl: string; token?: string; user?: AccountUser }
export interface HttpCentralOptions extends CentralTransport {
  account: SavedAccount
  persist(account: SavedAccount): Promise<void>
  authorize(client: HttpCentralClient): Promise<void>
  cookieAuth?: boolean
  openExternal?: (url: string) => Promise<unknown>
}

export function serverAddress(input: string): string {
  const url = new URL(input)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Use HTTPS for the server address")
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Invalid server address")
  return url.toString().replace(/\/$/, "")
}

/** Tokens stay inside the host transport. Neither shared UI nor Electron renderer receives them. */
export class HttpCentralClient implements CentralApi, SiteAdministrationApi {
  #account: SavedAccount
  readonly #options: HttpCentralOptions
  readonly #listeners = new Set<(event: CentralEvent) => void>()
  #socket: CentralSocket | undefined
  #retry: ReturnType<typeof setTimeout> | undefined
  #retryDelay = RETRY_MIN_MS
  #heartbeat: ReturnType<typeof setInterval> | undefined
  #closeDeadline: ReturnType<typeof setTimeout> | undefined
  #probeTimer: ReturnType<typeof setTimeout> | undefined
  #lastReceived = 0
  #connected = false
  #disposed = false
  #csrf: string | undefined
  #recoveryEpoch = 0
  #recoveryPending = false
  readonly #recoveryRosters = new Map<string, RecoveryRoster>()
  /** Host-only resume hook. It is deliberately absent from the renderer IPC API. */
  readonly wake = (): void => {
    if (this.#disposed || !(this.#account.token || (this.#options.cookieAuth && this.#account.user))) return
    // A resume fences new work until the link proves itself, but it is not
    // evidence that the link is down. An unfocused window keeps the same
    // socket, so reporting an outage before the probe answers flashes a
    // disconnect notice on every focus change.
    this.#beginRecovery()
    if (this.#retry) {
      clearTimeout(this.#retry)
      this.#retry = undefined
      this.#retryDelay = RETRY_MIN_MS
    }
    const socket = this.#socket
    if (!socket) { this.#connect(); return }
    // Mobile browsers suspend timers and sockets while the app is backgrounded.
    // A resumed page must prove the link is alive instead of waiting for a tick.
    const fresh = Date.now() - this.#lastReceived <= IDLE_TIMEOUT_MS
    if (socket.readyState === WebSocket.CONNECTING && fresh) return
    if (socket.readyState === WebSocket.OPEN && fresh) { this.#probeLink(socket); return }
    this.#stale(socket, 0)
  }
  readonly #visibility = (): void => {
    if (document.visibilityState === "visible") this.wake()
  }
  readonly #pageShow = (event: PageTransitionEvent): void => {
    // Initial page load is not recovery; only a restored document needs a probe.
    if (event.persisted) this.wake()
  }
  /**
   * A suspended page can resume with an OPEN socket whose route is already
   * dead. Probe before replacing it so the server never holds two viewer
   * connections that both deliver the same event.
   */
  #probeLink(socket: CentralSocket): void {
    if (this.#probeTimer || this.#socket !== socket) return
    const received = this.#lastReceived
    try { socket.send(JSON.stringify({ type: "ping" })) }
    catch { this.#stale(socket, 0); return }
    this.#probeTimer = setTimeout(() => {
      this.#probeTimer = undefined
      if (this.#socket === socket && this.#lastReceived === received) this.#stale(socket, 0)
    }, PROBE_TIMEOUT_MS)
  }
  constructor(options: HttpCentralOptions) {
    this.#options = options
    this.#account = { ...options.account, serverUrl: serverAddress(options.account.serverUrl) }
    // Installed windows, PWAs, and native apps are suspended without closing the page.
    // A process switch can leave the WebView visible, so native resume dispatches
    // its own foreground event. Recover from that instead of a throttled timer.
    if (typeof window !== "undefined" && typeof document !== "undefined") {
      window.addEventListener("online", this.wake)
      window.addEventListener("pageshow", this.#pageShow)
      window.addEventListener(APP_FOREGROUND_EVENT, this.wake)
      document.addEventListener("visibilitychange", this.#visibility)
    }
  }
  async status(): Promise<AccountState> {
    let siteAdmin = false
    if (this.#account.token || this.#options.cookieAuth) {
      try {
        const result = await this.request<{ user: AccountUser; siteAdmin: boolean }>("GET", "/api/me")
        if (this.#account.user && this.#account.user.id !== result.user.id) this.#disconnect()
        this.#account.user = result.user
        siteAdmin = result.siteAdmin === true
        this.#connect()
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 401) throw error
        const wasSignedIn = !!(this.#account.user || this.#account.token)
        this.#disconnect()
        await this.#save({ serverUrl: this.#account.serverUrl })
        if (wasSignedIn) this.#emit({ type: "accountChanged" })
      }
    }
    return { serverUrl: this.#account.serverUrl, user: this.#account.user, siteAdmin }
  }
  async login(): Promise<void> { await this.#options.authorize(this) }
  async authorizationUrl(returnTo: string): Promise<{ authorizationUrl: string; loginVerifier: string }> {
    const result = await this.request<{ authorizationUrl: string; loginVerifier: string }>("POST", "/api/auth/start", { returnTo })
    return result
  }
  async exchange(code: string, loginVerifier: string): Promise<void> {
    const result = await this.request<{ token: string; user: AccountUser }>("POST", "/api/auth/exchange", { code, loginVerifier })
    await this.#save({ ...this.#account, token: result.token, user: result.user })
    this.#connect(); this.#emit({ type: "accountChanged" })
  }
  async logout(): Promise<void> {
    if (this.#options.cookieAuth) {
      // Only the server can remove an HttpOnly cookie; a failed logout stays visible.
      await this.request("POST", "/api/auth/logout")
      this.#disconnect(); await this.#save({ serverUrl: this.#account.serverUrl }); this.#emit({ type: "accountChanged" })
    } else {
      try { if (this.#account.token) await this.request("POST", "/api/auth/logout") }
      finally { this.#disconnect(); await this.#save({ serverUrl: this.#account.serverUrl }); this.#emit({ type: "accountChanged" }) }
    }
  }
  async #save(account: SavedAccount): Promise<void> {
    await this.#options.persist(account)
    if ((this.#account.token || this.#account.user) && (this.#account.token !== account.token || this.#account.user?.id !== account.user?.id)) this.#disconnect()
    this.#account = account
  }
  async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, options: Pick<ApiRequestOptions, "timeoutMs" | "totalTimeoutMs" | "retryStatusCodes" | "beforeFetch" | "decodeBody"> & { accept?: string } = {}): Promise<T> {
    if (this.#options.cookieAuth && !["GET", "HEAD"].includes(method) && !this.#csrf) {
      await this.request("GET", "/api/auth/config", undefined, signal)
    }
    const result = await apiRequest<{ csrfToken?: string }>(`${this.#account.serverUrl}${path}`, {
      ...options,
      method, credentials: this.#options.cookieAuth ? "include" : "omit",
      headers: { Accept: options.accept ?? "application/json", ...(this.#account.token ? { Authorization: `Bearer ${this.#account.token}` } : {}), ...(this.#options.cookieAuth && this.#csrf ? { "X-CSRF-Token": this.#csrf } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      json: body, signal, fetch: this.#options.fetch, transport: this.#options.transport,
    })
    if (result?.csrfToken) this.#csrf = result.csrfToken
    return result as T
  }
  async #open(url: string) {
    const parsed = new URL(url)
    serverAddress(parsed.origin)
    if (!this.#options.openExternal) throw new Error("This host cannot open external pages")
    await this.#options.openExternal(parsed.toString())
  }
  async openAccountSettings() {
    const { webUrl } = await this.request<{ webUrl: string }>("GET", "/api/auth/config")
    await this.#open(`${webUrl}/auth/account`)
  }
  githubSettings() { return this.request<GithubAppSettings>("GET", "/api/integrations/github") }
  async manageGithub() {
    const { manageUrl } = await this.githubSettings()
    if (!manageUrl) throw new Error("GitHub App is not configured")
    await this.#open(manageUrl)
  }
  async authorizeGithubApp() {
    const [{ webUrl }, account] = await Promise.all([
      this.request<{ webUrl: string }>("GET", "/api/auth/config"), this.status(),
    ])
    if (!account.user) throw new Error("Sign in to authorize GitHub")
    const url = new URL("/auth/github-app", webUrl)
    url.searchParams.set("user", account.user.id)
    await this.#open(url.toString())
  }
  setGithubActAsYou(actAsYou: boolean) { return this.request<GithubAppSettings>("PATCH", "/api/integrations/github", { actAsYou }) }
  githubPullRequest(query: GithubPullRequestQuery) {
    const params = new URLSearchParams({ owner: query.owner, repo: query.repo, branch: query.branch })
    if (query.headOwner) params.set("headOwner", query.headOwner)
    return this.request<{ pullRequest: GithubPullRequest | null }>("GET", `/api/integrations/github/pull-request?${params}`)
  }
  githubRepositoryItems(query: GithubRepositoryItemsQuery) {
    const params = new URLSearchParams({ owner: query.owner, repo: query.repo, kind: query.kind, includeClosed: String(query.includeClosed) })
    if (query.cursor) params.set("cursor", query.cursor)
    return this.request<GithubRepositoryItemsPage>("GET", `/api/integrations/github/repository-items?${params}`)
  }
  billing(teamId: string) { return this.request<TeamBilling>("GET", `/api/teams/${encodeURIComponent(teamId)}/billing`) }
  async checkout(teamId: string, plan: "go" | "pro", requestId: string, interval: BillingInterval = "month") {
    const { url } = await this.request<{ url: string }>("POST", `/api/teams/${encodeURIComponent(teamId)}/billing/checkout`, { plan, requestId, interval })
    await this.#open(url)
  }
  async billingPortal(teamId: string) {
    const { url } = await this.request<{ url: string }>("POST", `/api/teams/${encodeURIComponent(teamId)}/billing/portal`, {})
    await this.#open(url)
  }
  billingTeams(query: AdminTeamBillingQuery = {}): Promise<AdminTeamBillingPage> {
    const params = new URLSearchParams({ limit: String(query.limit ?? 20) })
    const search = query.search?.trim()
    if (search) params.set("search", search)
    if (query.cursor) params.set("cursor", query.cursor)
    return this.request<AdminTeamBillingPage>("GET", `/api/admin/teams?${params}`)
  }
  registrationPolicy() { return this.request<import("./account-security.ts").PublicAuthenticationPolicy>("GET", "/api/auth/config") }
  async updateRegistration(enabled: boolean) { await this.request("PATCH", "/api/auth/registration", { enabled }) }
  async updateCaptcha(enabled: boolean) { await this.request("PATCH", "/api/auth/captcha", { enabled }) }
  users(query: string) { return this.request<AdminAccount[]>("GET", `/api/admin/users?query=${encodeURIComponent(query)}`) }
  createUser(input: CreateAccountInput) { return this.request<AdminAccount>("POST", "/api/admin/users", input) }
  async disableUser(userId: string, disabled: boolean) { await this.request("PATCH", `/api/admin/users/${encodeURIComponent(userId)}/disabled`, { disabled }) }
  sendEmailCode() { return this.request<{ challengeId: string; expiresIn: number; retryAfter: number }>("POST", "/api/auth/reauthenticate/email", {}) }
  async verifyEmailCode(challengeId: string, code: string) { await this.request("POST", "/api/auth/reauthenticate/email/verify", { challengeId, code }) }
  authenticationMethods() { return this.request<import("./account-security.ts").AuthenticationMethods>("GET", "/api/auth/reauthenticate/methods") }
  async reauthenticate(password?: string) {
    if (password === undefined) await authenticatePasskey(this, "reauthenticate")
    else await this.request("POST", "/api/auth/reauthenticate", { password })
  }
  async setManualGrant(teamId: string, plan: "free" | "go" | "pro" | "enterprise" | null, expiresAt: number | null, reason: string) { await this.request("PUT", `/api/admin/teams/${encodeURIComponent(teamId)}/grant`, { plan, expiresAt, reason }) }
  deletionRequests(query: AccountDeletionRequestQuery = {}): Promise<AccountDeletionRequestPage> {
    const params = new URLSearchParams({ limit: String(query.limit ?? 20) })
    if (query.cursor) params.set("cursor", query.cursor)
    return this.request<AccountDeletionRequestPage>("GET", `/api/admin/account-deletion-requests?${params}`)
  }
  async reviewDeletionRequest(id: string, approve: boolean, note?: string) {
    await this.request("POST", `/api/admin/account-deletion-requests/${encodeURIComponent(id)}/review`, { approve, ...(note ? { note } : {}) })
  }
  site() { return this.request<SiteSettings>("GET", "/api/site") }
  async updateTelemetryConsent(update: TelemetryConsentUpdate) { await this.request("PUT", "/api/me/telemetry-consent", update) }
  /** Used by the desktop main process; renderer diagnostics never choose endpoints. */
  networkConfiguration(): Promise<NetworkConfiguration> {
    // The public configuration route can briefly return 404 during deployment.
    return this.request("GET", "/api/network-configuration", undefined, undefined, {
      timeoutMs: 5_000, totalTimeoutMs: 15_000, retryStatusCodes: [404, ...API_RETRY_STATUS_CODES],
    })
  }
  siteSettings() { return this.request<SiteSettings>("GET", "/api/admin/site-settings") }
  creditRates() { return this.request<CreditRates>("GET", "/api/admin/credit-rates") }
  updateCreditRates(rates: CreditRates) { return this.request<CreditRates>("PUT", "/api/admin/credit-rates", rates) }
  planQuotas() { return this.request<AdminPlanQuota[]>("GET", "/api/admin/plan-quotas") }
  updatePlanQuota(plan: HostedPlan, limits: PlanQuota) { return this.request<AdminPlanQuota>("PUT", `/api/admin/plan-quotas/${encodeURIComponent(plan)}`, limits) }
  usageTrends(period: SiteUsagePeriod) { return this.request<SiteUsageTrends>("GET", `/api/admin/usage-trends?${new URLSearchParams({ period })}`) }
  updateSiteSettings(settings: SiteSettings) { return this.request<SiteSettings>("PATCH", "/api/admin/site-settings", settings) }
  turnSettings() { return this.request<TurnSettings>("GET", "/api/admin/turn-settings") }
  updateTurnSettings(settings: TurnSettings) { return this.request<TurnSettings>("PATCH", "/api/admin/turn-settings", settings) }
  cloudflareTurnSettings() { return this.request<CloudflareTurnSettings>("GET", "/api/admin/cloudflare-turn-settings") }
  updateCloudflareTurnSettings(settings: CloudflareTurnSettingsUpdate) { return this.request<CloudflareTurnSettings>("PATCH", "/api/admin/cloudflare-turn-settings", settings) }
  teams() { return this.request<Team[]>("GET", "/api/teams") }
  createTeam(name: string) { return this.request<Team>("POST", "/api/teams", { name }) }
  async enrollHeadless(teamId: string, machine: { name: string; originId: string; localMachineId: string; identityToken: string }) {
    const result = await this.request<{ machine: WireMachine; token: string }>("POST", `/api/teams/${encodeURIComponent(teamId)}/machines`, machine)
    return { ...result, machine: machineFromWire(result.machine) }
  }
  members(teamId: string) { return this.request<TeamMember[]>("GET", `/api/teams/${encodeURIComponent(teamId)}/members`) }
  teamUsage(teamId: string) { return this.request<TeamUsage>("GET", `/api/teams/${encodeURIComponent(teamId)}/usage`) }
  superAgentAvailability(teamId: string) { return this.request<{ enabled: boolean }>("GET", `${superAgentPath(teamId)}/availability`) }
  superAgentSessions(teamId: string) { return this.request<SuperAgentSession[]>("GET", `${superAgentPath(teamId)}/sessions`) }
  superAgentUsage(teamId: string) { return this.request<SuperAgentUsage>("GET", `${superAgentPath(teamId)}/usage`) }
  createSuperAgentSession(teamId: string, operationId: string, message?: SuperAgentMessageContent) {
    return this.request<{ sessionId: string; deliveryId?: string }>("POST", `${superAgentPath(teamId)}/sessions`, { operationId, message })
  }
  sendSuperAgentMessage(teamId: string, sessionId: string, operationId: string, message: SuperAgentMessageContent) {
    return this.request<{ sessionId: string; deliveryId: string }>("POST", `${superAgentPath(teamId)}/sessions/${encodeURIComponent(sessionId)}/messages`, { operationId, message })
  }
  superAgentHistory(teamId: string, sessionId: string, startIndex: number, pendingSenders?: SuperAgentHistory["pendingSenders"]) {
    if (!Number.isSafeInteger(startIndex) || startIndex < 0) throw new RangeError("Invalid Super Agent history position")
    return this.request<SuperAgentHistory>("GET", `${superAgentPath(teamId)}/sessions/${encodeURIComponent(sessionId)}/stream?startIndex=${startIndex}`, undefined, undefined, {
      // The gateway permits a 120-second finite read while eve replays a long conversation.
      timeoutMs: 125_000, totalTimeoutMs: 135_000, accept: "application/x-ndjson",
      decodeBody: (text, response) => readSuperAgentHistory(text, response, startIndex, pendingSenders),
    })
  }
  teamTurnSettings(teamId: string) { return this.request<TeamTurnSettings>("GET", `/api/teams/${encodeURIComponent(teamId)}/turn-settings`) }
  updateTeamTurnSettings(teamId: string, settings: TeamTurnSettingsUpdate) { return this.request<TeamTurnSettings>("PATCH", `/api/teams/${encodeURIComponent(teamId)}/turn-settings`, settings) }
  aiUsage(teamId: string, query: AiUsageQuery) {
    return this.request<TeamAiUsage>("GET", `/api/teams/${encodeURIComponent(teamId)}/ai-usage?${new URLSearchParams({ period: query.period, timeZone: query.timeZone })}`)
  }
  aiUsageSessions(teamId: string, query: { date: string; timeZone: string }) {
    return this.request<TeamAiUsageSessions>("GET", `/api/teams/${encodeURIComponent(teamId)}/ai-usage/sessions?${new URLSearchParams(query)}`)
  }
  search(teamId: string, query: SearchQuery) {
    const params = new URLSearchParams({ q: query.q, kind: query.kind ?? "all" })
    if (query.cursor !== undefined) params.set("cursor", query.cursor)
    if (query.limit !== undefined) params.set("limit", String(query.limit))
    return this.request<SearchPage>("GET", `/api/teams/${encodeURIComponent(teamId)}/search?${params}`)
  }
  scheduleSnapshot(teamId: string, machineId: string) {
    return this.request<ScheduleSnapshot>("GET", `/api/teams/${encodeURIComponent(teamId)}/machines/${encodeURIComponent(machineId)}/schedules`)
  }
  renameTeam(teamId: string, name: string) { return this.request<Team>("PATCH", `/api/teams/${encodeURIComponent(teamId)}`, { name }) }
  invite(teamId: string, email: string, role: "admin" | "member") { return this.request<{ token: string; expiresAt: string }>("POST", `/api/teams/${encodeURIComponent(teamId)}/invites`, { email, role }) }
  acceptInvite(token: string) { return this.request<Team>("POST", "/api/invites/accept", { token }) }
  async setMemberRole(teamId: string, userId: string, role: "admin" | "member") { await this.request("PATCH", `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, { role }) }
  async removeMember(teamId: string, userId: string) { await this.request("DELETE", `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`) }
  async transferOwnership(teamId: string, userId: string) { await this.request("POST", `/api/teams/${encodeURIComponent(teamId)}/ownership`, { userId }) }
  async machines(teamId: string) { return (await this.request<WireMachine[]>("GET", `/api/teams/${encodeURIComponent(teamId)}/machines`)).map(machineFromWire) }
  async renameMachine(teamId: string, machineId: string, name: string) { return machineFromWire(await this.request<WireMachine>("PATCH", `/api/teams/${encodeURIComponent(teamId)}/machines/${encodeURIComponent(machineId)}`, { name })) }
  async removeMachine(teamId: string, machineId: string) { await this.request("DELETE", `/api/teams/${encodeURIComponent(teamId)}/machines/${encodeURIComponent(machineId)}`) }
  catalog(teamId: string, machineId: string) { return this.request<{ machineId: string; snapshot: CatalogSnapshot; lastObservedAt: string; providers?: ProviderDisplaySnapshot }>("GET", `/api/teams/${encodeURIComponent(teamId)}/machines/${encodeURIComponent(machineId)}/catalog`) }
  async sessions(teamId: string, machineId: string, sessionId?: string): Promise<AgentSessionSummary[]> {
    const sessions: AgentSessionSummary[] = []
    const filter = sessionId === undefined ? "" : `&sessionId=${encodeURIComponent(sessionId)}`
    let after = "0"
    for (;;) {
      const page = await this.request<{ sessions: AgentSessionSummary[]; nextCursor?: string }>("GET", `/api/teams/${encodeURIComponent(teamId)}/machines/${encodeURIComponent(machineId)}/sessions?after=${encodeURIComponent(after)}&limit=200${filter}`)
      sessions.push(...page.sessions)
      if (!page.nextCursor) return sessions
      after = page.nextCursor
    }
  }
  session(teamId: string, machineId: string, sessionId: string) { return this.request<{ snapshot: AgentSnapshot; lastEventSeq: string; lastObservedAt: string }>("GET", `/api/teams/${encodeURIComponent(teamId)}/machines/${encodeURIComponent(machineId)}/sessions/${encodeURIComponent(sessionId)}`) }
  events(teamId: string, machineId: string, sessionId: string, after: string, limit: number) { return this.request<{ events: AgentEvent[]; lastEventSeq: string }>("GET", `/api/teams/${encodeURIComponent(teamId)}/machines/${encodeURIComponent(machineId)}/sessions/${encodeURIComponent(sessionId)}/events?after=${encodeURIComponent(after)}&limit=${limit}`) }
  async rpc<T>(teamId: string, machineId: string, method: string, params: unknown) { const beforeFetch = await this.#admitMachine(teamId, machineId); return this.request<T>("POST", `/api/teams/${encodeURIComponent(teamId)}/machines/${encodeURIComponent(machineId)}/rpc`, { method, params }, undefined, { beforeFetch }) }
  async createPeer(teamId: string, machineId: string, purpose: "agent" | "terminal" | "desktop" | "files" | "ports" | "mux") { const beforeFetch = await this.#admitMachine(teamId, machineId); return this.request<PeerGrant>("POST", "/api/peers", { teamId, machineId, purpose }, undefined, { beforeFetch }) }
  async createLocalPeer(teamId: string, machineId: string, purpose: "agent" | "terminal") { const beforeFetch = await this.#admitMachine(teamId, machineId); return this.request<LocalPeerGrant>("POST", "/api/peers/local", { teamId, machineId, purpose }, undefined, { beforeFetch }) }
  offerPeer(peerId: string, sdp: string, options?: PeerOfferOptions) { return this.request<{ sdp: string }>("POST", `/api/peers/${encodeURIComponent(peerId)}/offer`, { sdp, options }) }
  async startPeer(peerId: string, options: PeerStartOptions) { await this.request("POST", `/api/peers/${encodeURIComponent(peerId)}/start`, options) }
  async candidatePeer(peerId: string, candidate: IceCandidate) { await this.request("POST", `/api/peers/${encodeURIComponent(peerId)}/candidate`, { candidate }) }
  async closePeer(peerId: string) { await this.request("DELETE", `/api/peers/${encodeURIComponent(peerId)}`) }
  async savePushSubscription(subscription: PushSubscriptionInput) { await this.request("PUT", "/api/push/subscription", subscription) }
  async removePushSubscription() { await this.request("DELETE", "/api/push/subscription") }
  onEvent(listener: (event: CentralEvent) => void): () => void { this.#listeners.add(listener); this.#connect(); return () => this.#listeners.delete(listener) }
  #emit(event: CentralEvent): void { for (const listener of this.#listeners) listener(event) }
  #setConnected(value: boolean, force = false): void {
    if (this.#connected === value && !force) return
    this.#connected = value
    this.#emit({ type: "connection", connected: value })
  }
  #invalidateRoster(teamId?: string): void {
    for (const [team, roster] of this.#recoveryRosters) {
      if (teamId !== undefined && team !== teamId) continue
      this.#recoveryRosters.delete(team)
      roster.reject(recovering())
      roster.controller.abort()
    }
  }
  /** Fence new machine work until this resume proves the link and a current roster. */
  #beginRecovery(): void {
    this.#recoveryEpoch++
    this.#recoveryPending = true
    this.#invalidateRoster()
  }
  /** The link is known to be down; consumers keep their authorized peers. */
  #recover(): void {
    this.#beginRecovery()
    // Also invalidate an in-flight UI roster when a second disconnect happens
    // before the first probe finishes. Existing peer traffic remains usable.
    this.#setConnected(false, true)
  }
  async #admitMachine(teamId: string, machineId: string): Promise<() => void> {
    // Preserve initial API-only clients. Known recovery is the admission boundary;
    // it does not turn every operation into a network health check.
    if (this.#recoveryEpoch === 0) return () => { if (this.#recoveryEpoch !== 0) throw recovering() }
    if (this.#disposed || !this.#connected || this.#recoveryPending) throw recovering()
    const epoch = this.#recoveryEpoch
    let roster = this.#recoveryRosters.get(teamId)
    if (!roster) {
      let resolve!: (machines: Machine[]) => void
      let reject!: (error: unknown) => void
      const promise = new Promise<Machine[]>((yes, no) => { resolve = yes; reject = no })
      roster = { controller: new AbortController(), promise, reject }
      this.#recoveryRosters.set(teamId, roster)
      const current = roster
      void this.request<WireMachine[]>("GET", `/api/teams/${encodeURIComponent(teamId)}/machines`, undefined, roster.controller.signal).then(machines => machines.map(machineFromWire)).then(machines => {
        if (this.#recoveryRosters.get(teamId) !== current) return
        resolve(machines)
      }, error => {
        if (this.#recoveryRosters.get(teamId) !== current) return
        this.#recoveryRosters.delete(teamId)
        reject(error)
      })
    }
    const machines = await roster.promise
    return () => {
      // Check immediately before fetch too: cookie-auth may first await CSRF.
      if (epoch !== this.#recoveryEpoch || !this.#connected || this.#recoveryPending || this.#disposed || this.#recoveryRosters.get(teamId) !== roster) throw recovering()
      if (!machines.some(machine => machine.id === machineId && machine.online)) throw new Error("Machine is offline or no longer available. Try again when it reconnects.")
    }
  }
  #connect(): void {
    if (this.#disposed || !(this.#account.token || (this.#options.cookieAuth && this.#account.user)) || this.#socket || this.#retry) return
    const url = new URL(`${this.#account.serverUrl}/api/client/ws`); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    const socket = (this.#options.socket ?? (url => new WebSocket(url)))(url.toString())
    this.#socket = socket
    let authenticated = false
    this.#lastReceived = Date.now()
    socket.onopen = () => { if (!this.#options.cookieAuth) socket.send(JSON.stringify({ type: "authenticate", token: this.#account.token })) }
    socket.onmessage = ({ data }) => {
      if (this.#socket !== socket) return
      let event: SocketMessage
      try { event = JSON.parse(String(data)) as SocketMessage } catch { return }
      this.#lastReceived = Date.now()
      const probing = this.#probeTimer !== undefined
      clearTimeout(this.#probeTimer); this.#probeTimer = undefined
      if (probing && authenticated) { this.#recoveryPending = false; this.#setConnected(true) }
      if (event.type === "presence" || event.type === "machinesChanged") this.#invalidateRoster(event.teamId)
      if (event.type === "ready") { authenticated = true; this.#recoveryPending = false; this.#retryDelay = RETRY_MIN_MS; this.#setConnected(true) }
      else if (event.type === "ping") socket.send(JSON.stringify({ type: "pong" }))
      else if (event.type !== "pong") this.#emit(event)
    }
    socket.onerror = () => socket.close()
    socket.onclose = (event) => {
      if (this.#socket !== socket) return
      this.#socket = undefined
      clearInterval(this.#heartbeat); this.#heartbeat = undefined
      clearTimeout(this.#closeDeadline); this.#closeDeadline = undefined
      clearTimeout(this.#probeTimer); this.#probeTimer = undefined
      // A signaling outage is not a peer revocation. Existing DataChannels keep running.
      this.#recover()
      if (event.code === 4401) {
        void this.#save({ serverUrl: this.#account.serverUrl }).then(() => this.#emit({ type: "accountChanged" }))
      } else this.#schedule()
    }
    this.#heartbeat = setInterval(() => {
      if (this.#socket !== socket) return
      // Suspended pages cannot answer pings; reconnect when the page resumes.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return
      if (Date.now() - this.#lastReceived > IDLE_TIMEOUT_MS) this.#stale(socket)
      // Sending while CONNECTING or CLOSING throws; an unfinished upgrade only ages out.
      else if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }))
    }, HEARTBEAT_MS)
  }
  /**
   * A silent socket never reports close, and the WebSocket close handshake has no
   * deadline. Declare the link dead, then replace it if the orderly close stalls.
   */
  #stale(socket: CentralSocket, graceMs = CLOSE_GRACE_MS): void {
    if (this.#socket !== socket || this.#closeDeadline) return
    clearTimeout(this.#probeTimer); this.#probeTimer = undefined
    this.#recover()
    socket.close()
    this.#closeDeadline = setTimeout(() => {
      this.#closeDeadline = undefined
      if (this.#socket !== socket) return
      this.#socket = undefined
      clearInterval(this.#heartbeat); this.#heartbeat = undefined
      this.#schedule(graceMs === 0)
    }, graceMs)
  }
  #schedule(immediate = false): void {
    if (this.#disposed || this.#retry || !(this.#account.token || (this.#options.cookieAuth && this.#account.user))) return
    this.#retry = setTimeout(() => { this.#retry = undefined; this.#connect() }, immediate ? 0 : this.#retryDelay)
    if (!immediate) this.#retryDelay = Math.min(this.#retryDelay * 2, RETRY_MAX_MS)
  }
  #disconnect(): void {
    this.#recoveryEpoch++
    this.#recoveryPending = false
    this.#invalidateRoster()
    clearTimeout(this.#retry); this.#retry = undefined
    clearInterval(this.#heartbeat); this.#heartbeat = undefined
    clearTimeout(this.#closeDeadline); this.#closeDeadline = undefined
    clearTimeout(this.#probeTimer); this.#probeTimer = undefined
    this.#connected = false
    const socket = this.#socket; this.#socket = undefined; socket?.close()
  }
  dispose(): void {
    this.#disposed = true
    if (typeof window !== "undefined" && typeof document !== "undefined") {
      window.removeEventListener("online", this.wake)
      window.removeEventListener("pageshow", this.#pageShow)
      window.removeEventListener(APP_FOREGROUND_EVENT, this.wake)
      document.removeEventListener("visibilitychange", this.#visibility)
    }
    this.#disconnect()
    this.#listeners.clear()
  }
}
