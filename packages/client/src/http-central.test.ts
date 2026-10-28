import { afterEach, expect, test, vi } from "vitest"
import { HttpCentralClient } from "./http-central.ts"

const clients: HttpCentralClient[] = []
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); vi.useRealTimers() })
class Socket {
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onerror?: () => void
  onclose?: (event: { code: number }) => void
  send = vi.fn()
  close = vi.fn()
}
function setup() {
  const responses: unknown[] = []
  const fetch = vi.fn(async () => new Response(JSON.stringify(responses.shift() ?? {}), { status: 200, headers: { "Content-Type": "application/json" } }))
  const sockets: Socket[] = []
  const persist = vi.fn(async () => {})
  const client = new HttpCentralClient({ account: { serverUrl: "https://fleet.example", token: "application-token" }, persist, authorize: async () => {}, fetch, socket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket } })
  clients.push(client)
  return { client, fetch, sockets, responses, persist }
}

test("exchanges the callback code with its client verifier and exposes account data without the token", async () => {
  const f = setup()
  f.responses.push({ authorizationUrl: "https://login.example", loginVerifier: "verifier" }, { token: "new-token", user: { id: "u1", name: "Ada" } }, { user: { id: "u1", name: "Ada" } })
  expect(await f.client.authorizationUrl("https://app.example/")).toEqual({ authorizationUrl: "https://login.example", loginVerifier: "verifier" })
  await f.client.exchange("callback-code", "verifier")
  const request = f.fetch.mock.calls[1] as unknown as [string, RequestInit]
  expect(JSON.parse(request[1].body as string)).toEqual({ code: "callback-code", loginVerifier: "verifier" })
  expect(await f.client.status()).toEqual({ serverUrl: "https://fleet.example", siteAdmin: false, user: { id: "u1", name: "Ada" } })
  expect(f.persist).toHaveBeenCalledWith(expect.objectContaining({ token: "new-token" }))
})

test("authenticates the WebSocket in its first message and reports signaling loss without fabricating peer revocation", async () => {
  vi.useFakeTimers()
  const f = setup(); const events = vi.fn()
  f.client.onEvent(events)
  f.sockets[0]!.onopen!()
  expect(f.sockets[0]!.send).toHaveBeenCalledWith(JSON.stringify({ type: "authenticate", token: "application-token" }))
  f.sockets[0]!.onmessage!({ data: JSON.stringify({ type: "ready" }) })
  f.sockets[0]!.onclose!({ code: 1006 })
  expect(events.mock.calls.map(([event]) => event)).toEqual([{ type: "connection", connected: true }, { type: "connection", connected: false }])
  await vi.advanceTimersByTimeAsync(2_000)
  expect(f.sockets).toHaveLength(2)
})

test("collects Session summary pages without merging equal IDs from another machine", async () => {
  const f = setup()
  f.responses.push({ sessions: [{ session: { id: "1" } }], nextCursor: "1" }, { sessions: [{ session: { id: "3" } }] })
  expect(await f.client.sessions("remote7")).toEqual([{ session: { id: "1" } }, { session: { id: "3" } }])
  expect(f.fetch).toHaveBeenNthCalledWith(2, "https://fleet.example/api/machines/remote7/sessions?after=1&limit=200", expect.anything())
})

test("loads team AI usage and day details with explicit timezone and encoded team identity", async () => {
  const f = setup()
  const summary = { period: "30d", timeZone: "Asia/Shanghai", totals: { totalTokens: 123 } }
  const details = { date: "2026-10-28", timeZone: "Asia/Shanghai", sessions: [], truncated: false }
  f.responses.push(summary, details)
  expect(await f.client.aiUsage("team/1", { period: "30d", timeZone: "Asia/Shanghai" })).toEqual(summary)
  expect(await f.client.aiUsageSessions("team/1", { date: "2026-10-28", timeZone: "Asia/Shanghai" })).toEqual(details)
  expect(f.fetch).toHaveBeenNthCalledWith(1, "https://fleet.example/api/teams/team%2F1/ai-usage?period=30d&timeZone=Asia%2FShanghai", expect.objectContaining({ method: "GET" }))
  expect(f.fetch).toHaveBeenNthCalledWith(2, "https://fleet.example/api/teams/team%2F1/ai-usage/sessions?date=2026-10-28&timeZone=Asia%2FShanghai", expect.objectContaining({ method: "GET" }))
})

test("loads a targeted Session summary using the indexed collection filter", async () => {
  const f = setup()
  const summary = { session: { id: "7", title: "Task" }, turns: [], permissions: [], elicitations: [] }
  f.responses.push({ sessions: [summary] })
  expect(await f.client.sessions("remote/7", "7")).toEqual([summary])
  expect(f.fetch).toHaveBeenCalledExactlyOnceWith(
    "https://fleet.example/api/machines/remote%2F7/sessions?after=0&limit=200&sessionId=7", expect.anything(),
  )
})

test("collects paginated billing Teams while retaining the administration array API", async () => {
  const f = setup()
  const first = { id: "first", name: "First Team" }, second = { id: "second", name: "Second Team" }
  f.responses.push({ teams: [first], nextCursor: "team/a?b" }, { teams: [second], nextCursor: null })
  expect(await f.client.billingTeams()).toEqual([first, second])
  expect(f.fetch).toHaveBeenNthCalledWith(1, "https://fleet.example/api/admin/teams?limit=100", expect.anything())
  expect(f.fetch).toHaveBeenNthCalledWith(2, "https://fleet.example/api/admin/teams?limit=100&cursor=team%2Fa%3Fb", expect.anything())
})

test("reports API errors and falls back to HTTP status for non-JSON failures", async () => {
  const f = setup()
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "machine_offline", message: "target machine is unavailable" } }), { status: 503 }))
  await expect(f.client.catalog("remote7")).rejects.toMatchObject({ status: 503, message: "target machine is unavailable" })
  f.fetch.mockResolvedValueOnce(new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" }))
  await expect(f.client.catalog("remote7")).rejects.toMatchObject({ status: 502, message: "Bad Gateway" })
})

test("signing out notifies account-owned connections and retains the configured backend", async () => {
  const f = setup(); const events = vi.fn()
  f.client.onEvent(events)
  await f.client.logout()
  expect(await f.client.status()).toEqual({ serverUrl: "https://fleet.example", siteAdmin: false, user: undefined })
  expect(f.sockets[0]!.close).toHaveBeenCalledOnce()
  expect(events).toHaveBeenCalledExactlyOnceWith({ type: "accountChanged" })
  expect(f.persist).toHaveBeenCalledExactlyOnceWith({ serverUrl: "https://fleet.example" })
})

test("an expired account notifies connections after clearing saved credentials", async () => {
  const f = setup(); const events = vi.fn()
  f.client.onEvent(events)
  f.fetch.mockResolvedValueOnce(new Response("{}", { status: 401 }))
  expect(await f.client.status()).toEqual({ serverUrl: "https://fleet.example", siteAdmin: false, user: undefined })
  expect(f.persist).toHaveBeenCalledWith({ serverUrl: "https://fleet.example" })
  expect(f.sockets[0]!.close).toHaveBeenCalledOnce()
  expect(events).toHaveBeenCalledExactlyOnceWith({ type: "accountChanged" })
})

test("site administrator capabilities are refreshed from the server without persisting them", async () => {
  const f = setup()
  f.responses.push({ user: { id: "u1", name: "Ada" }, siteAdmin: true }, { user: { id: "u1", name: "Ada" }, siteAdmin: false })
  expect((await f.client.status()).siteAdmin).toBe(true)
  expect((await f.client.status()).siteAdmin).toBe(false)
  expect(f.persist).not.toHaveBeenCalled()
})

test("loads public settings and saves site settings through the admin endpoint", async () => {
  const f = setup()
  const settings = { siteName: "Studio fleet", announcement: "News", allowTeamCreation: false, termsOfServiceUrl: "https://example.test/terms", privacyTermsUrl: "https://example.test/privacy" }
  f.responses.push(settings, settings, settings)
  expect(await f.client.site()).toEqual(settings)
  expect(await f.client.siteSettings()).toEqual(settings)
  expect(await f.client.updateSiteSettings(settings)).toEqual(settings)
  expect(f.fetch).toHaveBeenNthCalledWith(1, "https://fleet.example/api/site", expect.objectContaining({ method: "GET" }))
  expect(f.fetch).toHaveBeenNthCalledWith(2, "https://fleet.example/api/admin/site-settings", expect.objectContaining({ method: "GET" }))
  expect(f.fetch).toHaveBeenNthCalledWith(3, "https://fleet.example/api/admin/site-settings", expect.objectContaining({ method: "PATCH", body: JSON.stringify(settings) }))
})


test("browser requests use cookie authentication and CSRF, with no bearer WebSocket frame", async () => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ user: { id: "u1", name: "Ada" }, csrfToken: "csrf-token", siteAdmin: false }), { status: 200 }))
  const socket = new Socket()
  const persist = vi.fn(async () => {})
  const client = new HttpCentralClient({ account: { serverUrl: "https://fleet.example" }, cookieAuth: true, persist, authorize: async () => {}, fetch: fetch as typeof globalThis.fetch, socket: () => socket as unknown as WebSocket })
  clients.push(client)
  await client.status()
  socket.onopen!()
  expect(socket.send).not.toHaveBeenCalled()
  await client.createTeam("Team")
  expect(fetch).toHaveBeenLastCalledWith("https://fleet.example/api/teams", expect.objectContaining({ credentials: "include", headers: { "X-CSRF-Token": "csrf-token", "Content-Type": "application/json" } }))
  expect(persist).not.toHaveBeenCalled()
})

test("browser public mutations obtain a CSRF token before posting", async () => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ csrfToken: "first-csrf" }), { status: 200 }))
  const client = new HttpCentralClient({ account: { serverUrl: "https://fleet.example" }, cookieAuth: true, persist: async () => {}, authorize: async () => {}, fetch: fetch as typeof globalThis.fetch })
  clients.push(client)
  await client.request("POST", "/api/auth/register", { email: "ada@example.test" })
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://fleet.example/api/auth/config", "https://fleet.example/api/auth/register"])
  expect(fetch.mock.calls[1]![1].headers).toMatchObject({ "X-CSRF-Token": "first-csrf" })
})

test("failed browser logout keeps the authenticated connection until its cookie is revoked", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ user: { id: "u1", name: "Ada" }, csrfToken: "csrf" }), { status: 200 }))
  const socket = new Socket()
  const persist = vi.fn(async () => {})
  const client = new HttpCentralClient({ account: { serverUrl: "https://fleet.example" }, cookieAuth: true, persist, authorize: async () => {}, fetch, socket: () => socket as unknown as WebSocket })
  clients.push(client)
  const events = vi.fn(); client.onEvent(events)
  await client.status()
  fetch.mockRejectedValueOnce(new Error("Network unavailable"))
  await expect(client.logout()).rejects.toThrow("Network unavailable")
  expect(persist).not.toHaveBeenCalled()
  expect(socket.close).not.toHaveBeenCalled()
  expect(events).not.toHaveBeenCalled()
  fetch.mockResolvedValueOnce(new Response(null, { status: 204 }))
  await client.logout()
  expect(socket.close).toHaveBeenCalledOnce()
  expect(events).toHaveBeenCalledExactlyOnceWith({ type: "accountChanged" })
})
