import type { ProviderDisplaySnapshot } from "./providers.ts"
import type { AccountState, AccountUser, GithubAppSettings, GithubPullRequest, GithubPullRequestQuery, AgentSessionSummary, CentralApi, CentralEvent, LocalPeerGrant, Machine, PeerGrant, SiteAdministrationApi, SiteSettings, TurnSettings, CloudflareTurnSettings, CloudflareTurnSettingsUpdate, Team, TeamMember, TeamTurnSettings, TeamTurnSettingsUpdate, TeamUsage } from "./central.ts"
import type { CatalogSnapshot } from "./catalog.ts"
import type { AgentEvent, AgentSnapshot } from "../../../apps/daemon/src/agent-protocol.ts"
import type { IceCandidate } from "./desktop-media.ts"
import type { BillingInterval, TeamBilling, AdminTeamBilling } from "./billing.ts"
import type { AiUsageQuery, TeamAiUsage, TeamAiUsageSessions } from "./ai-usage.ts"
import type { ScheduleSnapshot, SearchPage, SearchQuery } from "./search.ts"
import { authenticatePasskey } from "./passkeys.ts"
import { centralRequestFailure } from "./request-diagnostics.ts"
import type { NetworkConfiguration } from "../../../crates/protocol/control.ts"
import { isDesktopErrorReason, type DesktopErrorReason } from "./desktop-media.ts"

const HEARTBEAT_MS = 20_000
const IDLE_TIMEOUT_MS = 60_000
/** WebSocket close only requests a handshake; a dead peer never answers and no deadline exists. */
const CLOSE_GRACE_MS = 2_000
const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 30_000
/** Resume probes replace a socket only when the link misses this round trip. */
const PROBE_TIMEOUT_MS = 3_000

type SocketMessage = CentralEvent | { type: "ready" } | { type: "ping" } | { type: "pong" }

export interface SavedAccount { serverUrl: string; token?: string; user?: AccountUser }
export interface HttpCentralOptions {
  account: SavedAccount
  persist(account: SavedAccount): Promise<void>
  authorize(client: HttpCentralClient): Promise<void>
  fetch?: typeof fetch
  socket?: (url: string) => WebSocket
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
  #socket: WebSocket | undefined
  #retry: ReturnType<typeof setTimeout> | undefined
  #retryDelay = RETRY_MIN_MS
  #heartbeat: ReturnType<typeof setInterval> | undefined
  #closeDeadline: ReturnType<typeof setTimeout> | undefined
  #probeTimer: ReturnType<typeof setTimeout> | undefined
  #lastReceived = 0
  #connected = false
  #disposed = false
  #csrf: string | undefined
  readonly #wake = (): void => {
    if (this.#disposed || !(this.#account.token || (this.#options.cookieAuth && this.#account.user))) return
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
    if (document.visibilityState === "visible") this.#wake()
  }
  /**
   * A suspended page can resume with an OPEN socket whose route is already
   * dead. Probe before replacing it so the server never holds two viewer
   * connections that both deliver the same event.
   */
  #probeLink(socket: WebSocket): void {
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
    // Installed windows and mobile PWAs are suspended without closing the page.
    // Recover on resume and on network changes rather than on a throttled timer.
    if (typeof window !== "undefined" && typeof document !== "undefined") {
      window.addEventListener("online", this.#wake)
      window.addEventListener("pageshow", this.#wake)
      document.addEventListener("visibilitychange", this.#visibility)
    }
  }
  async status(): Promise<AccountState> {
    let siteAdmin = false
    if (this.#account.token || this.#options.cookieAuth) {
      try {
        const result = await this.request<{ user: AccountUser; siteAdmin: boolean }>("GET", "/api/me")
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
  async #save(account: SavedAccount): Promise<void> { await this.#options.persist(account); this.#account = account }
  async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const requestStack = new Error()
    if (this.#options.cookieAuth && !["GET", "HEAD"].includes(method) && !this.#csrf) {
      await this.request("GET", "/api/auth/config", undefined, signal)
    }
    const init: RequestInit = {
      method, credentials: this.#options.cookieAuth ? "include" : "omit",
      headers: { ...(this.#account.token ? { Authorization: `Bearer ${this.#account.token}` } : {}), ...(this.#options.cookieAuth && this.#csrf ? { "X-CSRF-Token": this.#csrf } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    }
    const started = performance.now()
    let response: Response
    try { response = await (this.#options.fetch ?? fetch)(`${this.#account.serverUrl}${path}`, init) }
    catch (cause) { throw centralRequestFailure(cause, { method, path, body, elapsedMs: performance.now() - started }, requestStack.stack) }
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: { code: string; message: string; reason?: string } }
      throw new HttpError(response.status, error.error?.message ?? response.statusText, isDesktopErrorReason(error.error?.reason) ? error.error.reason : undefined, error.error?.code)
    }
    const result = response.status === 204 ? undefined : await response.json() as { csrfToken?: string }
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
  billing(teamId: string) { return this.request<TeamBilling>("GET", `/api/teams/${encodeURIComponent(teamId)}/billing`) }
  async checkout(teamId: string, plan: "go" | "pro", requestId: string, interval: BillingInterval = "month") {
    const { url } = await this.request<{ url: string }>("POST", `/api/teams/${encodeURIComponent(teamId)}/billing/checkout`, { plan, requestId, interval })
    await this.#open(url)
  }
  async billingPortal(teamId: string) {
    const { url } = await this.request<{ url: string }>("POST", `/api/teams/${encodeURIComponent(teamId)}/billing/portal`, {})
    await this.#open(url)
  }
  async billingTeams(): Promise<AdminTeamBilling[]> {
    const teams: AdminTeamBilling[] = []
    let cursor: string | null = null
    do {
      const suffix = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`
      const page: { teams: AdminTeamBilling[]; nextCursor: string | null } = await this.request("GET", `/api/admin/teams?limit=100${suffix}`)
      teams.push(...page.teams)
      cursor = page.nextCursor
    } while (cursor !== null)
    return teams
  }
  registrationPolicy() { return this.request<{ registrationEnabled: boolean }>("GET", "/api/auth/config") }
  async updateRegistration(enabled: boolean) { await this.request("PATCH", "/api/auth/registration", { enabled }) }
  users(query: string) { return this.request<Array<{ id: string; name: string; email: string; disabled: boolean }>>("GET", `/api/admin/users?query=${encodeURIComponent(query)}`) }
  async disableUser(userId: string, disabled: boolean) { await this.request("PATCH", `/api/admin/users/${encodeURIComponent(userId)}/disabled`, { disabled }) }
  sendEmailCode() { return this.request<{ challengeId: string; expiresIn: number; retryAfter: number }>("POST", "/api/auth/reauthenticate/email", {}) }
  async verifyEmailCode(challengeId: string, code: string) { await this.request("POST", "/api/auth/reauthenticate/email/verify", { challengeId, code }) }
  authenticationMethods() { return this.request<import("./account-security.ts").AuthenticationMethods>("GET", "/api/auth/reauthenticate/methods") }
  async reauthenticate(password?: string) {
    if (password === undefined) await authenticatePasskey(this, "reauthenticate")
    else await this.request("POST", "/api/auth/reauthenticate", { password })
  }
  async setEnterprise(teamId: string, enabled: boolean) { await this.request("PUT", `/api/admin/teams/${encodeURIComponent(teamId)}/enterprise`, { enabled }) }
  site() { return this.request<SiteSettings>("GET", "/api/site") }
  /** Used by the desktop main process; renderer diagnostics never choose endpoints. */
  async networkConfiguration(): Promise<NetworkConfiguration> {
    const signal = AbortSignal.timeout(5_000)
    for (let attempt = 0; ; attempt++) {
      try { return await this.request<NetworkConfiguration>("GET", "/api/network-configuration", undefined, signal) }
      catch (error) {
        // This configuration endpoint can return intermittent 404s. Bound retries
        // by both attempt count and the original deadline.
        if (!(error instanceof HttpError) || error.status !== 404 || attempt >= 2 || signal.aborted) throw error
      }
    }
  }
  siteSettings() { return this.request<SiteSettings>("GET", "/api/admin/site-settings") }
  updateSiteSettings(settings: SiteSettings) { return this.request<SiteSettings>("PATCH", "/api/admin/site-settings", settings) }
  turnSettings() { return this.request<TurnSettings>("GET", "/api/admin/turn-settings") }
  updateTurnSettings(settings: TurnSettings) { return this.request<TurnSettings>("PATCH", "/api/admin/turn-settings", settings) }
  cloudflareTurnSettings() { return this.request<CloudflareTurnSettings>("GET", "/api/admin/cloudflare-turn-settings") }
  updateCloudflareTurnSettings(settings: CloudflareTurnSettingsUpdate) { return this.request<CloudflareTurnSettings>("PATCH", "/api/admin/cloudflare-turn-settings", settings) }
  teams() { return this.request<Team[]>("GET", "/api/teams") }
  createTeam(name: string) { return this.request<Team>("POST", "/api/teams", { name }) }
  enrollHeadless(teamId: string, machine: { name: string; originId: string; localMachineId: string; identityToken: string }) { return this.request<{ machine: Machine; token: string }>("POST", `/api/teams/${encodeURIComponent(teamId)}/machines`, machine) }
  members(teamId: string) { return this.request<TeamMember[]>("GET", `/api/teams/${encodeURIComponent(teamId)}/members`) }
  teamUsage(teamId: string) { return this.request<TeamUsage>("GET", `/api/teams/${encodeURIComponent(teamId)}/usage`) }
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
  machines(teamId: string) { return this.request<Machine[]>("GET", `/api/teams/${encodeURIComponent(teamId)}/machines`) }
  renameMachine(teamId: string, machineId: string, name: string) { return this.request<Machine>("PATCH", `/api/teams/${encodeURIComponent(teamId)}/machines/${encodeURIComponent(machineId)}`, { name }) }
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
  rpc<T>(teamId: string, machineId: string, method: string, params: unknown) { return this.request<T>("POST", `/api/teams/${encodeURIComponent(teamId)}/machines/${encodeURIComponent(machineId)}/rpc`, { method, params }) }
  createPeer(teamId: string, machineId: string, purpose: "agent" | "terminal" | "desktop" | "files" | "ports" | "mux") { return this.request<PeerGrant>("POST", "/api/peers", { teamId, machineId, purpose }) }
  createLocalPeer(teamId: string, machineId: string, purpose: "agent" | "terminal") { return this.request<LocalPeerGrant>("POST", "/api/peers/local", { teamId, machineId, purpose }) }
  offerPeer(peerId: string, sdp: string, options?: unknown) { return this.request<{ sdp: string }>("POST", `/api/peers/${encodeURIComponent(peerId)}/offer`, { sdp, options }) }
  async startPeer(peerId: string, options: { displayId: number; control?: boolean }) { await this.request("POST", `/api/peers/${encodeURIComponent(peerId)}/start`, options) }
  async candidatePeer(peerId: string, candidate: IceCandidate) { await this.request("POST", `/api/peers/${encodeURIComponent(peerId)}/candidate`, { candidate }) }
  async closePeer(peerId: string) { await this.request("DELETE", `/api/peers/${encodeURIComponent(peerId)}`) }
  onEvent(listener: (event: CentralEvent) => void): () => void { this.#listeners.add(listener); this.#connect(); return () => this.#listeners.delete(listener) }
  #emit(event: CentralEvent): void { for (const listener of this.#listeners) listener(event) }
  #setConnected(value: boolean): void {
    if (this.#connected === value) return
    this.#connected = value
    this.#emit({ type: "connection", connected: value })
  }
  #connect(): void {
    if (this.#disposed || !(this.#account.token || (this.#options.cookieAuth && this.#account.user)) || this.#socket || this.#retry) return
    const url = new URL(`${this.#account.serverUrl}/api/client/ws`); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    const socket = (this.#options.socket ?? (url => new WebSocket(url)))(url.toString())
    this.#socket = socket
    this.#lastReceived = Date.now()
    socket.onopen = () => { if (!this.#options.cookieAuth) socket.send(JSON.stringify({ type: "authenticate", token: this.#account.token })) }
    socket.onmessage = ({ data }) => {
      if (this.#socket !== socket) return
      let event: SocketMessage
      try { event = JSON.parse(String(data)) as SocketMessage } catch { return }
      this.#lastReceived = Date.now()
      clearTimeout(this.#probeTimer); this.#probeTimer = undefined
      if (event.type === "ready") { this.#retryDelay = RETRY_MIN_MS; this.#setConnected(true) }
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
      this.#setConnected(false)
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
  #stale(socket: WebSocket, graceMs = CLOSE_GRACE_MS): void {
    if (this.#socket !== socket || this.#closeDeadline) return
    clearTimeout(this.#probeTimer); this.#probeTimer = undefined
    this.#setConnected(false)
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
      window.removeEventListener("online", this.#wake)
      window.removeEventListener("pageshow", this.#wake)
      document.removeEventListener("visibilitychange", this.#visibility)
    }
    this.#disconnect()
    this.#listeners.clear()
  }
}
export class HttpError extends Error {
  readonly status: number
  readonly reason?: DesktopErrorReason
  readonly code?: string
  constructor(status: number, message: string, reason?: DesktopErrorReason, code?: string) { super(message); this.status = status; this.reason = reason; this.code = code }
}
