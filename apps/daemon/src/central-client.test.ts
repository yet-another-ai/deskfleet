import assert from "node:assert/strict"
import { EventEmitter, once } from "node:events"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import { openInMemoryCatalog } from "@deskfleet/native"
import { startDaemon } from "./daemon.ts"
import { DaemonClient } from "./control-client.ts"
import { CentralClient } from "./central-client.ts"
import type { MachineOperations } from "./machine-operations.ts"
import type { ControlPeers } from "./control-server.ts"
import { centralUrl } from "./central-protocol.ts"

test("local discovery grants only host setup and never imports development resources", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-central-auth-"))
  const development = await startDaemon(0, { controlDirectory: directory, allowLocalControlForTests: true, permissionPlatform: "darwin" as const, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
  const old = await DaemonClient.connect(() => {}, () => {}, directory)
  await old.call("workspaceCreate", { name: "Development data", directories: [{ path: directory }] })
  old.close(); await development.close()
  const daemon = await startDaemon(0, { controlDirectory: directory, permissionPlatform: "darwin" as const, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
  const client = await DaemonClient.connect(() => {}, () => {}, directory)
  context.after(async () => {
    client.close()
    await daemon.close()
    await rm(directory, { recursive: true, force: true })
  })
  const status = await client.call("centralStatus", {})
  assert.equal(status.configured, false)
  assert.equal(status.connected, false)
  assert.equal(status.revoked, false)
  for (const method of ["catalogList", "providerList", "terminalList", "systemStatus"] as const) await assert.rejects(client.call(method, {}), /Sign in and select a team/)
  await assert.rejects(client.call("workspaceCreate", { name: "Unauthorized", directories: [{ path: directory }] }), /backend API/)
})

test("enrollment verifies local machine identity and saves only a private daemon credential", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-enroll-"))
  const daemon = await startDaemon(0, { controlDirectory: directory, openCatalog: (_path, name) => openInMemoryCatalog(name), permissionPlatform: "darwin" as const, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
  const identity = daemon.central.status().identity
  let originId = "wrong"
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer machine-secret")
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ serverId: "server", machine: { id: "machine", teamId: "team", originId, localMachineId: identity.machineId } }))
  })
  server.on("upgrade", (_request, socket) => socket.destroy())
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  context.after(async () => {
    await daemon.close()
    await server[Symbol.asyncDispose]()
    await rm(directory, { recursive: true, force: true })
  })
  const credentials = { serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, machineId: "machine", teamId: "team", token: "machine-secret" }
  await assert.rejects(daemon.central.enroll(credentials), /do not match/)
  originId = identity.originId
  const status = await daemon.central.enroll(credentials)
  assert.equal(status.configured, true)
  assert.equal("token" in status, false)
  const path = join(directory, "machine", "central.json")
  assert.equal(JSON.parse(await readFile(path, "utf8")).token, "machine-secret")
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600)
  await assert.rejects(daemon.central.enroll(credentials), /already belongs/)
})

test("remote enrollment requires TLS and accepts HTTP only on loopback", () => {
  assert.equal(centralUrl("http://localhost:8080"), "http://localhost:8080")
  assert.throws(() => centralUrl("http://backend.example"), /HTTPS/)
  assert.throws(() => centralUrl("https://user:secret@backend.example"), /origin URL/)
})

test("delegation rechecks membership without treating a removed user as a revoked machine", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-delegation-"))
  const daemon = await startDaemon(0, { controlDirectory: directory, openCatalog: (_path, name) => openInMemoryCatalog(name), permissionPlatform: "darwin" as const, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
  const identity = daemon.central.status().identity
  let status = 200
  const users: string[] = []
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer machine-secret")
    response.setHeader("content-type", "application/json")
    if (request.url === "/api/daemon/me") {
      response.end(JSON.stringify({ serverId: "server", machine: { id: "machine", teamId: "team", originId: identity.originId, localMachineId: identity.machineId } }))
    } else if (request.url === "/api/daemon/authorize-delegation") {
      let body = ""
      for await (const chunk of request) body += chunk
      users.push(JSON.parse(body).userId)
      response.writeHead(status)
      response.end(JSON.stringify({ authorized: status === 200 }))
    } else response.end("{}")
  })
  server.on("upgrade", (_request, socket) => socket.destroy())
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  context.after(async () => { await daemon.close(); await server[Symbol.asyncDispose](); await rm(directory, { recursive: true, force: true }) })
  const actor = { kind: "user" as const, userId: "creator", deviceId: "original-login" }
  await assert.rejects(daemon.central.authorizeDelegation(actor), /unavailable/)
  await daemon.central.enroll({ serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, machineId: "machine", teamId: "team", token: "machine-secret" })
  await assert.rejects(daemon.central.authorizeDelegation({ kind: "local_token" }), /verified/)
  assert.deepEqual(await daemon.central.authorizeDelegation(actor), actor)
  status = 403
  await assert.rejects(daemon.central.authorizeDelegation(actor), /403/)
  assert.equal(daemon.central.status().revoked, false)
  status = 401
  await assert.rejects(daemon.central.authorizeDelegation(actor), /401/)
  assert.equal(daemon.central.status().revoked, true)
  assert.deepEqual(users, ["creator", "creator", "creator"])
})

test("read and signaling RPCs do not republish catalogs; resource events still synchronize", { timeout: 10_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-sync-events-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, "central.json"), JSON.stringify({
    serverUrl: "http://127.0.0.1:8080", serverId: "server", teamId: "team", machineId: "machine", token: "secret",
  }))
  let socket!: Socket
  const replies: { type: string; id?: string; error?: unknown }[] = []
  class Socket extends EventTarget {
    static OPEN = 1
    readyState = Socket.OPEN
    constructor() { super(); socket = this }
    send(value: string) { replies.push(JSON.parse(value)) }
    close() { this.readyState = 3 }
    receive(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })) }
  }
  context.mock.property(globalThis, "WebSocket", Socket as unknown as typeof WebSocket)
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  const posts: string[] = []
  const published = new EventEmitter()
  context.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    posts.push(String(url))
    published.emit(new URL(String(url)).pathname)
    return Response.json({ lastEventSeq: "1" })
  })
  let catalogChanged = () => {}, providersChanged = () => {}, terminalsChanged = () => {}
  let agentChanged = (_event: { sessionId: string }) => {}
  let hasSession = false
  const snapshot = () => ({ session: { id: "session", lastEventSeq: "1" } })
  const operations = {
    agents: {
      onEvent: (listener: typeof agentChanged) => { agentChanged = listener; return () => {} },
      journal: {
        identity: { originId: "origin", machineId: "local" },
        list: async () => hasSession ? [snapshot().session] : [], read: async () => snapshot(),
        commands: async () => [], serial: async (_id: string, action: () => Promise<unknown>) => action(),
        history: async () => [{ sessionId: "session", seq: "1" }],
      },
    },
    catalog: { native: { snapshot: async () => ({}) }, onChange: (listener: () => void) => { catalogChanged = listener; return () => {} } },
    providers: { metadata: () => ({}), onChanged: (listener: () => void) => { providersChanged = listener; return () => {} } },
    terminals: { onChange: (listener: () => void) => { terminalsChanged = listener; return () => {} } },
    handle: async () => [],
  } as unknown as MachineOperations
  const central = new CentralClient(directory, operations, {} as ControlPeers)
  context.after(() => central.close())
  await central.init()
  const flush = async (path?: string) => {
    // The native capability probe can finish after an event-loop turn. Await the
    // actual publication when one is expected, while still controlling batching.
    const publication = path ? once(published, path) : undefined
    context.mock.timers.tick(250)
    await publication
    await setImmediate()
  }
  const catalogs = () => posts.filter(url => url.endsWith("/catalog")).length
  socket.receive({ type: "ready", serverId: "server", machineId: "machine", teamId: "team" })
  await flush("/api/daemon/catalog")
  assert.equal(catalogs(), 1)
  for (const method of ["terminalList", "systemStatus", "peer.close"]) {
    socket.receive({ type: "request", id: method, method, params: { peerId: "closed-peer" } })
  }
  await setImmediate()
  await flush()
  assert.deepEqual(new Map(replies.map(({ id, error }) => [id, error])), new Map([["terminalList", undefined], ["systemStatus", undefined], ["peer.close", undefined]]))
  assert.equal(catalogs(), 1, "Reading terminal lists and system status must not start a catalogChanged feedback loop")
  for (const changed of [catalogChanged, providersChanged, terminalsChanged]) {
    const before = catalogs()
    changed(); await flush("/api/daemon/catalog")
    assert.equal(catalogs(), before + 1)
  }
  hasSession = true
  agentChanged({ sessionId: "session" }); await flush("/api/daemon/history")
  assert.equal(posts.filter(url => url.endsWith("/history")).length, 1)
  assert.equal(catalogs(), 4)
})


test("final synchronization has a shared deadline when the backend stops responding", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-final-sync-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  let posts = 0
  const server = createServer(() => { posts++ /* Accept the request without answering. */ })
  server.on("upgrade", (_request, socket) => socket.destroy())
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  context.after(() => { server.closeAllConnections(); server.close() })
  await writeFile(join(directory, "central.json"), JSON.stringify({
    serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    serverId: "server", teamId: "team", machineId: "machine", token: "secret",
  }))
  const unsubscribe = () => () => {}
  const operations = {
    agents: { journal: { identity: { originId: "origin", machineId: "local" }, list: async () => [] }, onEvent: unsubscribe },
    catalog: { native: { snapshot: async () => ({}) }, onChange: unsubscribe },
    providers: { metadata: () => ({}), onChanged: unsubscribe },
    terminals: { onChange: unsubscribe },
  } as unknown as MachineOperations
  const central = new CentralClient(directory, operations, {} as ControlPeers, 100)
  await central.init()
  const started = Date.now()
  const closing = central.close()
  assert.equal(central.close(), closing)
  await closing
  assert.equal(posts, 1)
  assert.ok(Date.now() - started < 2_000, "Shutdown must not wait for the normal 30-second sync timeout")
})

test("explicit credential rejection persists logout without treating transport loss as revocation", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-revoked-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  let requests = 0
  const server = createServer((_request, response) => { requests++; response.writeHead(401).end() })
  server.on("upgrade", (_request, socket) => socket.destroy())
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  context.after(() => { server.closeAllConnections(); server.close() })
  const path = join(directory, "central.json")
  await writeFile(path, JSON.stringify({
    serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    serverId: "server", teamId: "team", machineId: "machine", token: "revoked-secret",
  }))
  const unsubscribe = () => () => {}
  const operations = {
    agents: { journal: { identity: { originId: "origin", machineId: "local" }, list: async () => [] }, onEvent: unsubscribe },
    catalog: { native: { snapshot: async () => ({}) }, onChange: unsubscribe },
    providers: { metadata: () => ({}), onChanged: unsubscribe }, terminals: { onChange: unsubscribe },
  } as unknown as MachineOperations
  const central = new CentralClient(directory, operations, {} as ControlPeers)
  await central.init()
  assert.equal(central.status().revoked, false)
  await central.close()
  assert.equal(central.status().revoked, true)
  assert.equal(JSON.parse(await readFile(path, "utf8")).revoked, true)
  const restored = new CentralClient(directory, operations, {} as ControlPeers)
  await restored.init()
  assert.equal(restored.status().configured, true)
  assert.equal(restored.status().revoked, true)
  assert.equal(restored.status().identity.originId, "origin")
  await restored.close()
  assert.equal(requests, 1, "A revoked registration must not upload again after restart")
})
