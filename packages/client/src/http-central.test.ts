import { afterEach, expect, test, vi } from "vitest"
import { HttpCentralClient } from "./http-central.ts"

const clients: HttpCentralClient[] = []
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); vi.useRealTimers() })
class Socket {
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onerror?: () => void
  onclose?: () => void
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
  expect(await f.client.status()).toEqual({ serverUrl: "https://fleet.example", user: { id: "u1", name: "Ada" } })
  expect(f.persist).toHaveBeenCalledWith(expect.objectContaining({ token: "new-token" }))
})

test("authenticates the WebSocket in its first message and reports signaling loss without fabricating peer revocation", async () => {
  vi.useFakeTimers()
  const f = setup(); const events = vi.fn()
  f.client.onEvent(events)
  f.sockets[0]!.onopen!()
  expect(f.sockets[0]!.send).toHaveBeenCalledWith(JSON.stringify({ type: "authenticate", token: "application-token" }))
  f.sockets[0]!.onmessage!({ data: JSON.stringify({ type: "ready" }) })
  f.sockets[0]!.onclose!()
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

test("changing servers invalidates account observers before another account connects", async () => {
  const f = setup()
  const events = vi.fn()
  f.client.onEvent(events)
  expect(await f.client.setServer("https://another.example")).toEqual({ serverUrl: "https://another.example", user: undefined })
  expect(events).toHaveBeenCalledExactlyOnceWith({ type: "accountChanged" })
  expect(f.sockets[0]!.close).toHaveBeenCalledOnce()
  expect(f.persist).toHaveBeenCalledExactlyOnceWith({ serverUrl: "https://another.example" })
})

test("reports API errors and falls back to HTTP status for non-JSON failures", async () => {
  const f = setup()
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "machine_offline", message: "target machine is unavailable" } }), { status: 503 }))
  await expect(f.client.catalog("remote7")).rejects.toMatchObject({ status: 503, message: "target machine is unavailable" })
  f.fetch.mockResolvedValueOnce(new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" }))
  await expect(f.client.catalog("remote7")).rejects.toMatchObject({ status: 502, message: "Bad Gateway" })
})

test("changing servers notifies account-owned file connections and clears the old account", async () => {
  const f = setup(); const events = vi.fn()
  f.client.onEvent(events)
  expect(await f.client.setServer("https://other.example")).toEqual({ serverUrl: "https://other.example", user: undefined })
  expect(f.sockets[0]!.close).toHaveBeenCalledOnce()
  expect(events).toHaveBeenCalledExactlyOnceWith({ type: "accountChanged" })
  await f.client.setServer("https://other.example/")
  expect(events).toHaveBeenCalledOnce()
})

test("an expired account notifies connections after clearing saved credentials", async () => {
  const f = setup(); const events = vi.fn()
  f.client.onEvent(events)
  f.fetch.mockResolvedValueOnce(new Response("{}", { status: 401 }))
  expect(await f.client.status()).toEqual({ serverUrl: "https://fleet.example", user: undefined })
  expect(f.persist).toHaveBeenCalledWith({ serverUrl: "https://fleet.example" })
  expect(f.sockets[0]!.close).toHaveBeenCalledOnce()
  expect(events).toHaveBeenCalledExactlyOnceWith({ type: "accountChanged" })
})
