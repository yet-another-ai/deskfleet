import { afterEach, expect, test, vi } from "vitest"
import { APP_FOREGROUND_EVENT } from "./app-foreground.ts"
import { HttpCentralClient } from "./http-central.ts"
import { CentralRequestError } from "./request-diagnostics.ts"

class Socket {
  readyState = 1
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onclose?: (event: { code: number }) => void
  send = vi.fn()
  close = vi.fn()
  message(type: string) { this.onmessage?.({ data: JSON.stringify({ type }) }) }
}
const clients: HttpCentralClient[] = []
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function setup(cookieAuth = false, signalingReady = true) {
  const window = new EventTarget()
  vi.stubGlobal("window", window)
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }))
  const sockets: Socket[] = []
  const requests: Request[] = []
  const pending: { request: Request; resolve: (response: Response) => void }[] = []
  const fetch = vi.fn<typeof globalThis.fetch>(input => {
    const request = input as Request
    requests.push(request)
    if (request.url.endsWith("/machines")) return new Promise(resolve => pending.push({ request, resolve }))
    return Promise.resolve(Response.json(request.url.endsWith("/exchange") ? { token: "replacement", user: { id: "other", name: "Other" } } : {}))
  })
  const client = new HttpCentralClient({ account: { serverUrl: "https://fleet.example", token: "fixture", user: { id: "user", name: "User" } }, cookieAuth, persist: async () => {}, authorize: async () => {}, fetch,
    socket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket } })
  clients.push(client)
  const events = vi.fn()
  client.onEvent(events)
  const socket = sockets[0]!
  if (signalingReady) socket.message("ready")
  const resume = () => window.dispatchEvent(new Event(APP_FOREGROUND_EVENT))
  const readyRoster = async (online = true, index = 0) => {
    await vi.waitFor(() => expect(pending[index]).toBeDefined())
    pending[index]!.resolve(Response.json([{ id: "machine", online, capabilities: {} }]))
  }
  return { client, socket, sockets, requests, pending, resume, readyRoster, events, fetch }
}
function operations(client: HttpCentralClient, team = "team") {
  return [
    client.createPeer(team, "machine", "mux"),
    client.rpc(team, "machine", "_deskfleet/session/create", {}),
    client.rpc(team, "machine", "systemStatus", {}),
  ].map(result => result.catch(error => error))
}

test.each([false, true])("initial pageshow preserves startup admission when signaling ready is %s", async signalingReady => {
  const f = setup(false, signalingReady)
  f.events.mockClear()
  window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }))
  expect(f.events).not.toHaveBeenCalled()
  expect(f.socket.send).not.toHaveBeenCalled()
  await expect(f.client.rpc("team", "machine", "systemStatus", {})).resolves.toEqual({})
  expect(f.pending).toHaveLength(0)
  expect(f.requests).toHaveLength(1)
})

test("persisted pageshow requires a probe and current roster before new work", async () => {
  const f = setup()
  window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }))
  // Recovery fences new work; it does not claim the signaling link is down.
  expect(f.events.mock.calls.map(([event]) => event)).toEqual([{ type: "connection", connected: true }])
  expect(f.socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "ping" }))
  await expect(f.client.createPeer("team", "machine", "mux")).rejects.toThrow(/recovering/)
  expect(f.requests).toHaveLength(0)
  f.socket.message("pong")
  const creating = f.client.createPeer("team", "machine", "mux")
  await f.readyRoster()
  await expect(creating).resolves.toEqual({})
  expect(f.requests.filter(request => request.method === "POST")).toHaveLength(1)
})

test("native foreground while visible blocks new operations until probe and current roster finish", async () => {
  const f = setup()
  f.resume()
  const failures = await Promise.all(operations(f.client))
  expect(failures.every(error => error instanceof Error && /recovering/.test(error.message))).toBe(true)
  expect(failures.some(error => error instanceof CentralRequestError)).toBe(false)
  expect(f.requests).toHaveLength(0)
  expect(f.events.mock.calls.map(([event]) => event)).toEqual([{ type: "connection", connected: true }])
  f.socket.message("pong")
  const admitted = operations(f.client)
  await vi.waitFor(() => expect(f.pending).toHaveLength(1))
  expect(f.requests.every(request => request.method === "GET")).toBe(true)
  await f.readyRoster()
  expect(await Promise.all(admitted)).toEqual([{}, {}, {}])
  expect(f.requests.filter(request => request.method === "POST")).toHaveLength(3)
  await f.client.rpc("team", "machine", "systemStatus", {})
  expect(f.pending).toHaveLength(1)
})

test("a resume on a live link probes without reporting a disconnect", async () => {
  const f = setup()
  f.events.mockClear()
  f.resume()
  expect(f.socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "ping" }))
  expect(f.events).not.toHaveBeenCalled()
  f.socket.message("pong")
  const creating = f.client.createPeer("team", "machine", "mux")
  await f.readyRoster()
  await expect(creating).resolves.toEqual({})
  // A focus change keeps the same socket, so it must not flash a notice.
  expect(f.events).not.toHaveBeenCalled()
})

test("a resume after the idle deadline reports the link down before replacing it", async () => {
  vi.useFakeTimers()
  const f = setup()
  // The stubbed document is the object the client reads for heartbeat gating.
  Object.assign(document, { visibilityState: "hidden" })
  f.events.mockClear()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(f.socket.close).not.toHaveBeenCalled()
  f.resume()
  expect(f.events).toHaveBeenLastCalledWith({ type: "connection", connected: false })
  expect(f.socket.close).toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(10)
  expect(f.sockets).toHaveLength(2)
})

test("pong with an offline roster does not send createPeer, session create, or systemStatus", async () => {
  const f = setup()
  f.resume(); f.socket.message("pong")
  const results = operations(f.client)
  await f.readyRoster(false)
  const errors = await Promise.all(results)
  expect(errors.every(error => error instanceof Error && /offline/.test(error.message))).toBe(true)
  expect(f.requests.filter(request => request.method === "POST")).toHaveLength(0)
})

test("an earlier roster response cannot admit work after another resume", async () => {
  const f = setup()
  f.resume(); f.socket.message("pong")
  const obsolete = f.client.createPeer("team", "machine", "mux").catch(error => error)
  await vi.waitFor(() => expect(f.pending).toHaveLength(1))
  f.resume()
  expect(await obsolete).toMatchObject({ message: expect.stringMatching(/recovering/) })
  expect(f.pending[0]!.request.signal.aborted).toBe(true)
  f.socket.message("pong")
  const current = f.client.createPeer("team", "machine", "mux").catch(error => error)
  await f.readyRoster(true, 0)
  await f.readyRoster(false, 1)
  expect(await current).toMatchObject({ message: expect.stringMatching(/offline/) })
  expect(f.requests.filter(request => request.method === "POST")).toHaveLength(0)
})

test.each(["dispose", "logout", "exchange"] as const)("%s cancels an admission read before a late roster can dispatch", async action => {
  const f = setup()
  f.resume(); f.socket.message("pong")
  const operation = f.client.createPeer("team", "machine", "mux").catch(error => error)
  await vi.waitFor(() => expect(f.pending).toHaveLength(1))
  if (action === "exchange") await f.client.exchange("code", "verifier")
  else await f.client[action]()
  expect(await operation).toMatchObject({ message: expect.stringMatching(/recovering/) })
  expect(f.pending[0]!.request.signal.aborted).toBe(true)
  await f.readyRoster()
  expect(f.requests.some(request => request.url.endsWith("/api/peers"))).toBe(false)
})

test("recovery leaves catalog/auth reads and already authorized peer signaling available", async () => {
  const f = setup()
  f.resume()
  await f.client.teams()
  await f.client.catalog("team", "machine")
  await f.client.offerPeer("existing", "sdp")
  await f.client.closePeer("existing")
  expect(f.requests.map(request => request.method)).toEqual(["GET", "GET", "POST", "DELETE"])
})

test("recovered rosters remain Team scoped", async () => {
  const f = setup()
  f.resume(); f.socket.message("pong")
  const first = f.client.rpc("first", "machine", "systemStatus", {})
  await f.readyRoster()
  await first
  const second = f.client.createPeer("second", "machine", "mux").catch(error => error)
  await f.readyRoster(false, 1)
  expect(await second).toMatchObject({ message: expect.stringMatching(/offline/) })
  expect(f.requests.filter(request => request.method === "POST")).toHaveLength(1)
})

test("a wake inside the HTTP transport preparation still fences the actual fetch", async () => {
  const f = setup()
  const result = f.client.rpc("team", "machine", "_deskfleet/session/create", {}).catch(error => error)
  queueMicrotask(f.resume)
  const error = await result
  expect(error).toMatchObject({ message: expect.stringMatching(/recovering/) })
  expect(error).not.toBeInstanceOf(CentralRequestError)
  expect(f.requests).toHaveLength(0)
})

test("a wake while acquiring CSRF does not dispatch the pending write", async () => {
  const f = setup(true)
  const csrf = Promise.withResolvers<Response>()
  f.fetch.mockImplementationOnce(input => { f.requests.push(input as Request); return csrf.promise })
  const result = f.client.rpc("team", "machine", "_deskfleet/session/create", {}).catch(error => error)
  await vi.waitFor(() => expect(f.requests).toHaveLength(1))
  f.resume()
  csrf.resolve(Response.json({ csrfToken: "fixture-csrf" }))
  const error = await result
  expect(error).toMatchObject({ message: expect.stringMatching(/recovering/) })
  expect(error).not.toBeInstanceOf(CentralRequestError)
  expect(f.requests.every(request => request.method === "GET")).toBe(true)
})

test("new local grants use recovery admission too", async () => {
  const f = setup()
  f.resume()
  await expect(f.client.createLocalPeer("team", "machine", "terminal")).rejects.toThrow(/recovering/)
  expect(f.requests).toHaveLength(0)
  f.socket.message("pong")
  const result = f.client.createLocalPeer("team", "machine", "terminal")
  await f.readyRoster()
  await result
  expect(f.requests.at(-1)).toMatchObject({ url: "https://fleet.example/api/peers/local", method: "POST" })
})

test("a failed roster preserves the API error and permits a later read without replaying writes", async () => {
  const f = setup()
  f.resume(); f.socket.message("pong")
  f.fetch.mockResolvedValueOnce(Response.json({ error: { code: "forbidden", message: "Access denied" } }, { status: 403 }))
  await expect(f.client.createPeer("team", "machine", "mux")).rejects.toMatchObject({ status: 403, code: "forbidden", message: "Access denied" })
  expect(f.requests.filter(request => request.method === "POST")).toHaveLength(0)
  const result = f.client.createPeer("team", "machine", "mux")
  await f.readyRoster()
  await result
  expect(f.requests.filter(request => request.method === "POST")).toHaveLength(1)
})

test("presence invalidates a trusted roster before another operation", async () => {
  const f = setup()
  f.resume(); f.socket.message("pong")
  const first = f.client.createPeer("team", "machine", "mux")
  await f.readyRoster(); await first
  f.socket.onmessage?.({ data: JSON.stringify({ type: "presence", teamId: "team", machineId: "machine", online: false }) })
  const next = f.client.rpc("team", "machine", "systemStatus", {}).catch(error => error)
  await f.readyRoster(false, 1)
  expect(await next).toMatchObject({ message: expect.stringMatching(/offline/) })
  expect(f.requests.filter(request => request.method === "POST")).toHaveLength(1)
})


test("status detecting a cookie-account change cancels the previous account's admission", async () => {
  const f = setup(true)
  f.resume(); f.socket.message("pong")
  const previous = f.client.createPeer("team", "machine", "mux").catch(error => error)
  await vi.waitFor(() => expect(f.pending).toHaveLength(1))
  f.fetch.mockResolvedValueOnce(Response.json({ user: { id: "replacement", name: "Replacement" }, siteAdmin: false }))
  expect((await f.client.status()).user?.id).toBe("replacement")
  expect(await previous).toMatchObject({ message: expect.stringMatching(/recovering/) })
  expect(f.pending[0]!.request.signal.aborted).toBe(true)
  await f.readyRoster()
  expect(f.requests.some(request => request.url.endsWith("/api/peers"))).toBe(false)
})
