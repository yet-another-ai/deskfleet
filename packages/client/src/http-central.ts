import type { ProviderDisplaySnapshot } from "./providers.ts"
import type { AccountState, AccountUser, CentralApi, CentralEvent, Machine, PeerGrant, Team, TeamMember } from "./central.ts"
import type { CatalogSnapshot } from "./catalog.ts"
import type { AgentEvent, AgentSnapshot } from "../../../apps/daemon/src/agent-protocol.ts"
import type { IceCandidate } from "./desktop-media.ts"

export interface SavedAccount { serverUrl: string; token?: string; user?: AccountUser }
export interface HttpCentralOptions {
  account: SavedAccount
  persist(account: SavedAccount): Promise<void>
  authorize(client: HttpCentralClient): Promise<void>
  fetch?: typeof fetch
  socket?: (url: string) => WebSocket
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
export class HttpCentralClient implements CentralApi {
  #account: SavedAccount
  readonly #options: HttpCentralOptions
  readonly #listeners = new Set<(event: CentralEvent) => void>()
  #socket: WebSocket | undefined
  #retry: ReturnType<typeof setTimeout> | undefined
  #disposed = false
  constructor(options: HttpCentralOptions) { this.#options = options; this.#account = options.account }
  async status(): Promise<AccountState> {
    if (this.#account.token) {
      try {
        const result = await this.request<{ user: AccountUser }>("GET", "/api/me")
        this.#account.user = result.user
        this.#connect()
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 401) throw error
        await this.#save({ serverUrl: this.#account.serverUrl })
      }
    }
    return { serverUrl: this.#account.serverUrl, user: this.#account.user }
  }
  async setServer(address: string): Promise<AccountState> {
    const serverUrl = serverAddress(address)
    if (serverUrl !== this.#account.serverUrl) {
      this.#disconnect()
      await this.#save({ serverUrl })
      this.#emit({ type: "accountChanged" })
    }
    return this.status()
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
    try { if (this.#account.token) await this.request("POST", "/api/auth/logout") }
    finally { this.#disconnect(); await this.#save({ serverUrl: this.#account.serverUrl }); this.#emit({ type: "accountChanged" }) }
  }
  async #save(account: SavedAccount): Promise<void> { await this.#options.persist(account); this.#account = account }
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await (this.#options.fetch ?? fetch)(`${this.#account.serverUrl}${path}`, {
      method, headers: { ...(this.#account.token ? { Authorization: `Bearer ${this.#account.token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: { code: string; message: string } }
      throw new HttpError(response.status, error.error?.message ?? response.statusText)
    }
    return response.status === 204 ? undefined as T : await response.json() as T
  }
  teams() { return this.request<Team[]>("GET", "/api/teams") }
  createTeam(name: string) { return this.request<Team>("POST", "/api/teams", { name }) }
  enrollHeadless(teamId: string, machine: { name: string; originId: string; localMachineId: string }) { return this.request<{ machine: Machine; token: string }>("POST", `/api/teams/${encodeURIComponent(teamId)}/machines`, machine) }
  members(teamId: string) { return this.request<TeamMember[]>("GET", `/api/teams/${encodeURIComponent(teamId)}/members`) }
  renameTeam(teamId: string, name: string) { return this.request<Team>("PATCH", `/api/teams/${encodeURIComponent(teamId)}`, { name }) }
  invite(teamId: string, email: string, role: "admin" | "member") { return this.request<{ token: string; expiresAt: string }>("POST", `/api/teams/${encodeURIComponent(teamId)}/invites`, { email, role }) }
  acceptInvite(token: string) { return this.request<Team>("POST", "/api/invites/accept", { token }) }
  async setMemberRole(teamId: string, userId: string, role: "admin" | "member") { await this.request("PATCH", `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, { role }) }
  async removeMember(teamId: string, userId: string) { await this.request("DELETE", `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`) }
  machines(teamId: string) { return this.request<Machine[]>("GET", `/api/teams/${encodeURIComponent(teamId)}/machines`) }
  renameMachine(machineId: string, name: string) { return this.request<Machine>("PATCH", `/api/machines/${encodeURIComponent(machineId)}`, { name }) }
  async removeMachine(machineId: string) { await this.request("DELETE", `/api/machines/${encodeURIComponent(machineId)}`) }
  catalog(machineId: string) { return this.request<{ machineId: string; snapshot: CatalogSnapshot; lastObservedAt: string; providers?: ProviderDisplaySnapshot }>("GET", `/api/machines/${encodeURIComponent(machineId)}/catalog`) }
  async sessions(machineId: string): Promise<AgentSnapshot[]> {
    const sessions: AgentSnapshot[] = []
    let after = "0"
    for (;;) {
      const page = await this.request<{ sessions: AgentSnapshot[]; nextCursor?: string }>("GET", `/api/machines/${encodeURIComponent(machineId)}/sessions?after=${encodeURIComponent(after)}&limit=200`)
      sessions.push(...page.sessions)
      if (!page.nextCursor) return sessions
      after = page.nextCursor
    }
  }
  session(machineId: string, sessionId: string) { return this.request<{ snapshot: AgentSnapshot; lastEventSeq: string; lastObservedAt: string }>("GET", `/api/machines/${encodeURIComponent(machineId)}/sessions/${encodeURIComponent(sessionId)}`) }
  events(machineId: string, sessionId: string, after: string, limit: number) { return this.request<{ events: AgentEvent[]; lastEventSeq: string }>("GET", `/api/machines/${encodeURIComponent(machineId)}/sessions/${encodeURIComponent(sessionId)}/events?after=${encodeURIComponent(after)}&limit=${limit}`) }
  rpc<T>(machineId: string, method: string, params: unknown) { return this.request<T>("POST", `/api/machines/${encodeURIComponent(machineId)}/rpc`, { method, params }) }
  createPeer(teamId: string, machineId: string, purpose: "agent" | "terminal" | "desktop") { return this.request<PeerGrant>("POST", "/api/peers", { teamId, machineId, purpose }) }
  offerPeer(peerId: string, sdp: string, options?: unknown) { return this.request<{ sdp: string }>("POST", `/api/peers/${encodeURIComponent(peerId)}/offer`, { sdp, options }) }
  async startPeer(peerId: string, options: { displayId: number }) { await this.request("POST", `/api/peers/${encodeURIComponent(peerId)}/start`, options) }
  async candidatePeer(peerId: string, candidate: IceCandidate) { await this.request("POST", `/api/peers/${encodeURIComponent(peerId)}/candidate`, { candidate }) }
  async closePeer(peerId: string) { await this.request("DELETE", `/api/peers/${encodeURIComponent(peerId)}`) }
  onEvent(listener: (event: CentralEvent) => void): () => void { this.#listeners.add(listener); this.#connect(); return () => this.#listeners.delete(listener) }
  #emit(event: CentralEvent): void { for (const listener of this.#listeners) listener(event) }
  #connect(): void {
    if (this.#disposed || !this.#account.token || this.#socket || this.#retry) return
    const url = new URL(`${this.#account.serverUrl}/api/client/ws`); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    const socket = (this.#options.socket ?? (url => new WebSocket(url)))(url.toString())
    this.#socket = socket
    socket.onopen = () => socket.send(JSON.stringify({ type: "authenticate", token: this.#account.token }))
    socket.onmessage = ({ data }) => {
      let event: CentralEvent | { type: "ready" }
      try { event = JSON.parse(String(data)) as typeof event } catch { return }
      if (event.type === "ready") this.#emit({ type: "connection", connected: true })
      else this.#emit(event)
    }
    socket.onerror = () => socket.close()
    socket.onclose = () => {
      if (this.#socket !== socket) return
      this.#socket = undefined
      // A signaling outage is not a peer revocation. Existing DataChannels keep running.
      this.#emit({ type: "connection", connected: false })
      if (!this.#disposed && this.#account.token) this.#retry = setTimeout(() => { this.#retry = undefined; this.#connect() }, 2_000)
    }
  }
  #disconnect(): void {
    clearTimeout(this.#retry); this.#retry = undefined
    const socket = this.#socket; this.#socket = undefined; socket?.close()
  }
  dispose(): void { this.#disposed = true; this.#disconnect(); this.#listeners.clear() }
}
export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
