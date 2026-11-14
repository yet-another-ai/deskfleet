import { TestAgentQuotas } from "./fixtures/agent-quotas.ts"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
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

function journalIds() {
  let id = 0n
  return async () => String(++id)
}

test("local discovery grants only host setup and never imports development resources", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-central-auth-"))
  const development = await startDaemon(0, { controlDirectory: directory, agentQuotas: new TestAgentQuotas(), allowLocalControlForTests: true, permissionPlatform: "darwin" as const, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
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
  assert.deepEqual(status.registrations, [])
  for (const method of ["catalogList", "providerList", "terminalList", "systemStatus"] as const) await assert.rejects(client.call(method, {}), /Sign in and select a team/)
  await assert.rejects(client.call("providerDiscoverMcpServers", { providerId: "agent" }), /Sign in and select a team/)
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
  const credentials = { serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, machineId: "machine", teamId: "team", token: "machine-secret", originId: identity.originId }
  await assert.rejects(daemon.central.enroll(credentials), /do not match/)
  originId = identity.originId
  const status = await daemon.central.enroll(credentials)
  assert.equal(status.configured, true)
  assert.equal("token" in status, false)
  const path = join(directory, "machine", "central.json")
  assert.equal(JSON.parse(await readFile(path, "utf8")).token, "machine-secret")
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.deepEqual(await daemon.central.enroll(credentials), status)
  await assert.rejects(daemon.central.enroll({ ...credentials, token: "replacement-secret" }), /already enrolled/)
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
  const lookups: unknown[] = []
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
      response.end(JSON.stringify(status === 401 ? { error: { code: "machine_credential_rejected" } } : { authorized: status === 200 }))
    } else if (request.url === "/api/daemon/entitlements") {
      response.writeHead(status)
      response.end(JSON.stringify({ error: { message: "Team limit reached" } }))
    } else if (request.url === "/api/daemon/github/pull-request") {
      let body = ""
      for await (const chunk of request) body += chunk
      lookups.push(JSON.parse(body))
      response.writeHead(status)
      response.end(JSON.stringify({ pullRequest: { number: 3, title: "Merged", url: "https://github.com/owner/repo/pull/3", state: "merged" } }))
    } else response.end("{}")
  })
  server.on("upgrade", (_request, socket) => socket.destroy())
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  context.after(async () => { await daemon.close(); await server[Symbol.asyncDispose](); await rm(directory, { recursive: true, force: true }) })
  const actor = { kind: "user" as const, userId: "creator", deviceId: "original-login" }
  await assert.rejects(daemon.central.authorizeDelegation(actor), /unavailable/)
  await daemon.central.enroll({ serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, machineId: "machine", teamId: "team", token: "machine-secret", originId: identity.originId })
  await assert.rejects(daemon.central.authorizeDelegation({ kind: "local_token" }), /verified/)
  assert.deepEqual(await daemon.central.authorizeDelegation(actor), actor)
  const query = { owner: "owner", repo: "repo", branch: "fix/example" }
  await assert.rejects(daemon.central.githubPullRequest({ kind: "local_token" }, query), /verified/)
  assert.equal((await daemon.central.githubPullRequest(actor, query)).pullRequest?.state, "merged")
  assert.deepEqual(lookups, [{ userId: "creator", query }])
  status = 403
  await assert.rejects(daemon.central.authorizeDelegation(actor), /403/)
  await assert.rejects(daemon.central.githubPullRequest(actor, query), /403/)
  assert.equal(daemon.central.status().revoked, false)
  await assert.rejects(daemon.central.quotaRequest("GET", "/api/daemon/entitlements"), /Team limit reached/)
  assert.equal(daemon.central.status().revoked, false, "quota denials never revoke an enrolled machine")
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
    const address = url instanceof Request ? url.url : String(url)
    posts.push(address)
    published.emit(new URL(address).pathname)
    return Response.json({ lastEventSeq: "1" })
  })
  let catalogChanged = () => {}, providersChanged = () => {}, terminalsChanged = () => {}, schedulesChanged = () => {}
  let agentChanged = (_event: { sessionId: string }) => {}
  let hasSession = false
  const snapshot = () => ({ session: { id: "session", lastEventSeq: "1" } })
  const operations = {
    agents: { reconcileAdmissions: async () => {},
      onEvent: (listener: typeof agentChanged) => { agentChanged = listener; return () => {} },
      journal: {
        id: journalIds(),
        identity: { originId: "origin", machineId: "local" },
        list: async () => hasSession ? [snapshot().session] : [], read: async () => snapshot(),
        commandsSince: async () => ({ commands: [], revision: "-1" }), serial: async (_id: string, action: () => Promise<unknown>) => action(),
        history: async () => [{ sessionId: "session", seq: "1" }],
      },
    },
    catalog: { snapshot: async () => ({}), onChange: (listener: () => void) => { catalogChanged = listener; return () => {} } },
    providers: { metadata: () => ({}), onChanged: (listener: () => void) => { providersChanged = listener; return () => {} } },
    terminals: { onChange: (listener: () => void) => { terminalsChanged = listener; return () => {} } },
    schedules: { snapshot: () => [], onChanged: (listener: () => void) => { schedulesChanged = listener; return () => {} } },
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
  assert.equal(posts.filter(url => url.endsWith("/schedules")).length, 1)
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
  assert.equal(posts.filter(url => url.endsWith("/schedules")).length, 1, "Chat history does not republish schedules")
  schedulesChanged(); await flush("/api/daemon/schedules")
  assert.equal(posts.filter(url => url.endsWith("/schedules")).length, 2)
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
    agents: { reconcileAdmissions: async () => {}, journal: { id: journalIds(), identity: { originId: "origin", machineId: "local" }, list: async () => [] }, onEvent: unsubscribe },
    catalog: { snapshot: async () => ({}), onChange: unsubscribe },
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
  const server = createServer((_request, response) => {
    requests++
    response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "machine_credential_rejected" } }))
  })
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
    agents: { reconcileAdmissions: async () => {}, journal: { id: journalIds(), identity: { originId: "origin", machineId: "local" }, list: async () => [] }, onEvent: unsubscribe },
    catalog: { snapshot: async () => ({}), onChange: unsubscribe },
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

/** Minimal WebSocket server that upgrades, then closes with an application code. */
function closeAfterUpgrade(code: number, onAuthenticate?: (token: string) => void) {
  const server = createServer((_request, response) => response.setHeader("content-type", "application/json").end("{}"))
  let upgraded!: import("node:stream").Duplex
  let resolveClosed!: () => void
  const closed = new Promise<void>(resolve => { resolveClosed = resolve })
  const closeFrame = (value: number) => {
    const body = Buffer.alloc(2)
    body.writeUInt16BE(value, 0)
    return Buffer.concat([Buffer.from([0x88, body.length]), body])
  }
  server.on("upgrade", (request, socket) => {
    upgraded = socket
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    let received = Buffer.alloc(0)
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      socket.write(closeFrame(code))
      socket.end()
      resolveClosed()
    }
    if (!onAuthenticate) {
      finish()
      return
    }
    socket.on("data", chunk => {
      if (finished) return
      received = Buffer.concat([received, chunk])
      while (received.length >= 2) {
        const opcode = received[0]! & 0x0f
        const length = received[1]! & 0x7f
        const masked = (received[1]! & 0x80) !== 0
        const header = 2 + (masked ? 4 : 0)
        if (length >= 126 || received.length < header + length) return
        const body = Buffer.from(received.subarray(header, header + length))
        if (masked) {
          const mask = received.subarray(2, 6)
          for (let index = 0; index < body.length; index++) body[index] = body[index]! ^ mask[index % 4]!
        }
        received = received.subarray(header + length)
        if (opcode !== 1) continue
        const message = JSON.parse(body.toString()) as { type?: string; token?: string }
        if (message.type === "authenticate" && message.token) onAuthenticate(message.token)
        finish()
        return
      }
    })
  })
  return { server, closed, socket: () => upgraded }
}

test("network drop mid-hello reconnects with the same machine credentials instead of revoking", { timeout: 5_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-hello-retry-"))
  const { server, closed, socket } = closeAfterUpgrade(1012)
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  const credentials = {
    serverId: "server", machineId: "machine-keep", teamId: "team",
    serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "durable-secret",
  }
  const path = join(directory, "central.json")
  await writeFile(path, JSON.stringify(credentials))
  const unsubscribe = () => () => {}
  const operations = {
    agents: { journal: { id: journalIds(), identity: { originId: "origin", machineId: "local" }, list: async () => [] }, onEvent: unsubscribe },
    catalog: { snapshot: async () => ({}), onChange: unsubscribe },
    providers: { metadata: () => ({}), onChanged: unsubscribe }, terminals: { onChange: unsubscribe },
  } as unknown as MachineOperations
  const central = new CentralClient(directory, operations, {} as ControlPeers)
  context.after(async () => {
    await central.close()
    socket()?.destroy()
    await server[Symbol.asyncDispose]()
    await rm(directory, { recursive: true, force: true })
  })
  await central.init()
  await closed
  await setImmediate()
  assert.equal(central.status().revoked, false, "1012 is a retryable hello failure, not credential rejection")
  assert.equal(central.status().machineId, "machine-keep")
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), credentials)
  await central.stop()
})

test("credential rejection close still persists local revocation", { timeout: 5_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-hello-reject-"))
  const tokens: string[] = []
  const { server, closed, socket } = closeAfterUpgrade(4401, token => tokens.push(token))
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  const credentials = {
    serverId: "server", machineId: "machine-old", teamId: "team",
    serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "rejected-secret",
  }
  const path = join(directory, "central.json")
  await writeFile(path, JSON.stringify(credentials))
  const unsubscribe = () => () => {}
  const operations = {
    agents: { journal: { id: journalIds(), identity: { originId: "origin", machineId: "local" }, list: async () => [] }, onEvent: unsubscribe },
    catalog: { snapshot: async () => ({}), onChange: unsubscribe },
    providers: { metadata: () => ({}), onChanged: unsubscribe }, terminals: { onChange: unsubscribe },
  } as unknown as MachineOperations
  const central = new CentralClient(directory, operations, {} as ControlPeers)
  context.after(async () => {
    await central.close()
    socket()?.destroy()
    await server[Symbol.asyncDispose]()
    await rm(directory, { recursive: true, force: true })
  })
  await central.init()
  await closed
  await waitForRevoked(central, path)
  assert.deepEqual(tokens, ["rejected-secret"])
  assert.equal(central.status().revoked, true)
  assert.equal(JSON.parse(await readFile(path, "utf8")).machineId, "machine-old")
  await central.stop()
})

async function waitForRevoked(central: CentralClient, path: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (central.status().revoked) {
      try {
        if (JSON.parse(await readFile(path, "utf8")).revoked === true) return
      } catch { /* rename still in flight */ }
    }
    await new Promise(resolve => setTimeout(resolve, 10).unref())
  }
  assert.equal(central.status().revoked, true)
  assert.equal(JSON.parse(await readFile(path, "utf8")).revoked, true)
}

test("real Node WebSocket closes malformed control traffic without unhandled failures", { timeout: 5_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-control-failure-"))
  const errors: string[] = []
  context.mock.method(console, "error", (...values: unknown[]) => { errors.push(values.map(String).join(" ")) })
  const server = createServer((_request, response) => response.setHeader("content-type", "application/json").end("{}"))
  const closeCodes: number[] = []
  let upgraded!: import("node:stream").Duplex
  let resolveClosed!: () => void
  const closed = new Promise<void>(resolve => { resolveClosed = resolve })
  const textFrame = (value: string) => {
    const body = Buffer.from(value)
    assert.ok(body.length < 126)
    return Buffer.concat([Buffer.from([0x81, body.length]), body])
  }
  server.on("upgrade", (request, socket) => {
    upgraded = socket
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    // Exercise the actual Undici WebSocket restriction against application close(1002).
    socket.write(textFrame("{"))
    let received = Buffer.alloc(0)
    socket.on("data", chunk => {
      received = Buffer.concat([received, chunk])
      while (received.length >= 6) {
        const length = received[1]! & 0x7f
        assert.ok(length < 126, "fixture expects short client frames")
        if (received.length < 6 + length) return
        const opcode = received[0]! & 0x0f
        const mask = received.subarray(2, 6)
        const body = Buffer.from(received.subarray(6, 6 + length))
        for (let index = 0; index < body.length; index++) body[index] = body[index]! ^ mask[index % 4]!
        received = received.subarray(6 + length)
        if (opcode === 8) {
          closeCodes.push(body.length >= 2 ? body.readUInt16BE(0) : 1005)
          // A frame already in flight must not trigger another error while closing.
          socket.write(textFrame(JSON.stringify({ type: "reconcilePeers", peers: [] })))
          socket.end(Buffer.concat([Buffer.from([0x88, body.length]), body]))
        }
      }
    })
    socket.on("close", resolveClosed)
  })
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  const credentials = { serverId: "server", machineId: "machine", teamId: "team", serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "fixture-secret" }
  const path = join(directory, "central.json")
  await writeFile(path, JSON.stringify(credentials))
  const unsubscribe = () => () => {}
  const operations = {
    agents: { journal: { id: journalIds(), identity: { originId: "origin", machineId: "local" }, list: async () => [] }, onEvent: unsubscribe },
    catalog: { snapshot: async () => ({}), onChange: unsubscribe },
    providers: { metadata: () => ({}), onChanged: unsubscribe }, terminals: { onChange: unsubscribe },
  } as unknown as MachineOperations
  const central = new CentralClient(directory, operations, {} as ControlPeers)
  context.after(async () => { await central.close(); upgraded?.destroy(); await server[Symbol.asyncDispose](); await rm(directory, { recursive: true, force: true }) })
  await central.init()
  await closed
  await central.stop()
  assert.equal(central.status().connected, false)
  assert.equal(errors.length, 1, "a closing socket must ignore subsequent frames")
  assert.deepEqual(closeCodes, [4002])
  assert.equal(central.status().revoked, false)
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), credentials)
})

/** A WebSocket whose peer is gone: close() never produces a close event. */
function silentSockets(context: import("node:test").TestContext) {
  const sockets: SilentSocket[] = []
  class SilentSocket extends EventTarget {
    static OPEN = 1
    readyState = SilentSocket.OPEN
    closeCalls = 0
    readonly sent: unknown[] = []
    constructor() { super(); sockets.push(this) }
    send(value: string) { this.sent.push(JSON.parse(value)) }
    // No close event: a dead peer never answers the closing handshake.
    close() { this.closeCalls++; this.readyState = 3 }
    receive(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })) }
    /** A real transport error, which does emit close. */
    drop(code = 1012) {
      this.readyState = 3
      const event = new Event("close") as Event & { code: number }
      Object.defineProperty(event, "code", { value: code })
      this.dispatchEvent(event)
    }
  }
  context.mock.property(globalThis, "WebSocket", SilentSocket as unknown as typeof WebSocket)
  return { sockets }
}

function linkOperations(): MachineOperations {
  const unsubscribe = () => () => {}
  return {
    agents: {
      reconcileAdmissions: async () => {},
      journal: { id: journalIds(), identity: { originId: "origin", machineId: "local" }, list: async () => [] },
      onEvent: unsubscribe,
    },
    catalog: { snapshot: async () => ({}), onChange: unsubscribe },
    providers: { metadata: () => ({ providers: [] }), onChanged: unsubscribe },
    terminals: { onChange: unsubscribe },
    handle: async () => [],
  } as unknown as MachineOperations
}

async function linkClient(context: import("node:test").TestContext, directory: string) {
  await writeFile(join(directory, "central.json"), JSON.stringify({
    serverUrl: "http://127.0.0.1:8080", serverId: "server", teamId: "team", machineId: "machine", token: "secret",
  }))
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] })
  context.mock.method(globalThis, "fetch", async () => Response.json({ lastEventSeq: "1" }))
  const { sockets } = silentSockets(context)
  const central = new CentralClient(directory, linkOperations(), {} as ControlPeers)
  context.after(() => central.close())
  await central.init()
  return { central, sockets }
}

test("a silent control link is abandoned after a bounded grace and replaced", { timeout: 10_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-control-stale-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const { central, sockets } = await linkClient(context, directory)
  sockets[0]!.receive({ type: "ready", serverId: "server", machineId: "machine", teamId: "team" })
  assert.equal(central.status().connected, true)
  // Heartbeats tick at 20/40/60/80 s; the link has been idle past the 60 s limit.
  context.mock.timers.tick(80_000)
  assert.equal(sockets[0]!.closeCalls, 1, "the daemon requests an orderly close once")
  assert.equal(central.status().connected, false, "a dead link must not keep reporting connected")
  assert.equal(sockets.length, 1, "the replacement waits out the close grace period")
  context.mock.timers.tick(5_000)
  assert.equal(sockets.length, 1, "abandoning the socket only schedules the retry")
  context.mock.timers.tick(2_000)
  assert.equal(sockets.length, 2, "a new control link replaces the abandoned one")
})

test("control link retries back off while reconnects fail and reset after ready", { timeout: 10_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-control-backoff-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const { sockets } = await linkClient(context, directory)
  sockets[0]!.drop()
  context.mock.timers.tick(1_999)
  assert.equal(sockets.length, 1)
  context.mock.timers.tick(1)
  assert.equal(sockets.length, 2, "a dropped link retries after the minimum delay")
  sockets[1]!.drop()
  context.mock.timers.tick(3_999)
  assert.equal(sockets.length, 2, "the second failure waits longer than the first")
  context.mock.timers.tick(1)
  assert.equal(sockets.length, 3)
  sockets[2]!.receive({ type: "ready", serverId: "server", machineId: "machine", teamId: "team" })
  sockets[2]!.drop()
  context.mock.timers.tick(1_999)
  assert.equal(sockets.length, 3)
  context.mock.timers.tick(1)
  assert.equal(sockets.length, 4, "a ready link resets the retry delay")
})

test("a late rejection of a retired token cannot revoke a re-enrolled Team", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-token-reenroll-"))
  const { sockets } = silentSockets(context)
  let rejectOld!: (response: Response) => void
  const delayed = new Promise<Response>(resolve => { rejectOld = resolve })
  const credentials = { serverUrl: "http://127.0.0.1:8080", serverId: "server", teamId: "team", machineId: "machine", token: "old-token" }
  await writeFile(join(directory, "central.json"), JSON.stringify(credentials))
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const address = input instanceof Request ? input.url : String(input)
    if (address.endsWith("/api/daemon/entitlements")) return delayed
    if (address.endsWith("/api/daemon/me")) return Response.json({ serverId: "server", machine: { id: "machine", teamId: "team", originId: "origin", localMachineId: "local" } })
    return Response.json({ lastEventSeq: "0" })
  })
  const central = new CentralClient(directory, linkOperations(), {} as ControlPeers)
  context.after(async () => { rejectOld(Response.json({})); await central.close(); await rm(directory, { recursive: true, force: true }) })
  await central.init()
  const pending = central.quotaRequest("GET", "/api/daemon/entitlements")
  sockets[0]!.drop(4403)
  assert.equal(central.status().revoked, true)
  await central.enroll({ ...credentials, token: "new-token", originId: "origin" })
  const rejection = assert.rejects(pending, /Team allowance request failed/)
  rejectOld(Response.json({ error: { code: "machine_credential_rejected" } }, { status: 401 }))
  await rejection
  assert.equal(central.status().revoked, false)
  assert.equal(JSON.parse(await readFile(join(directory, "central.json"), "utf8")).token, "new-token")
})

async function httpClient(context: import("node:test").TestContext, request: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), "df-http-retry-"))
  silentSockets(context)
  context.mock.method(globalThis, "fetch", request)
  await writeFile(join(directory, "central.json"), JSON.stringify({
    serverUrl: "http://127.0.0.1:8080", serverId: "server", teamId: "team", machineId: "machine", token: "secret",
  }))
  const central = new CentralClient(directory, linkOperations(), {} as ControlPeers)
  context.after(async () => { await central.close(); await rm(directory, { recursive: true, force: true }) })
  await central.init()
  return central
}

test("quota reads and idempotent admission writes retry transient failures with the same request", async context => {
  for (const method of ["GET", "POST"] as const) {
    await context.test(method, async context => {
      const path = method === "GET" ? "/api/daemon/entitlements" : "/api/daemon/session-admissions"
      const body = method === "POST" ? { operationId: "operation", kind: "create" } : undefined
      const requests: { method: string; authorization: string | null; body: unknown }[] = []
      const expected = method === "GET" ? { maxTurnsPerSession: 30 } : { admissionId: "operation", generation: "operation", status: "reserved", sessionId: null }
      const central = await httpClient(context, async input => {
        assert.ok(input instanceof Request)
        if (!input.url.endsWith(path)) return Response.json({ lastEventSeq: "0" })
        requests.push({ method: input.method, authorization: input.headers.get("authorization"), body: input.body ? await input.json() : undefined })
        if (requests.length === 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error("Connection reset"), { code: "ECONNRESET" }) })
        if (requests.length === 2) return Response.json({ error: { message: "Temporarily unavailable" } }, { status: 503, headers: { "Retry-After": "0" } })
        return Response.json(expected)
      })
      assert.deepEqual(await central.quotaRequest(method, path, body), expected)
      assert.deepEqual(requests, Array.from({ length: 3 }, () => ({ method, authorization: "Bearer secret", body })))
      assert.equal(central.status().revoked, false)
    })
  }
})

test("MCP calls, delegation checks, and final synchronization do not retry transient HTTP failures", async context => {
  const requests: string[] = []
  const central = await httpClient(context, async input => {
    assert.ok(input instanceof Request)
    requests.push(new URL(input.url).pathname)
    return Response.json({ error: { message: "Temporarily unavailable" } }, { status: 503 })
  })
  await assert.rejects(central.remoteMcp({ userId: "user", deviceId: "device", sessionId: "session", operation: "machines", arguments: {} }), { status: 503, message: "Temporarily unavailable" })
  await assert.rejects(central.authorizeDelegation({ kind: "user", userId: "user", deviceId: "device" }), { status: 503, message: "Temporarily unavailable" })
  await central.close()
  assert.deepEqual(requests, ["/api/daemon/mcp", "/api/daemon/authorize-delegation", "/api/daemon/catalog"])
  assert.equal(central.status().revoked, false)
})

test("closing the daemon cancels a quota retry before another request is sent", async context => {
  let started!: () => void
  const firstRequest = new Promise<void>(resolve => { started = resolve })
  let requests = 0
  const central = await httpClient(context, async input => {
    assert.ok(input instanceof Request)
    if (!input.url.endsWith("/api/daemon/entitlements")) return Response.json({ lastEventSeq: "0" })
    requests++
    started()
    return Response.json({ error: { message: "Temporarily unavailable" } }, { status: 503, headers: { "Retry-After": "1" } })
  })
  const pending = central.quotaRequest("GET", "/api/daemon/entitlements")
  const rejection = assert.rejects(pending, { name: "AbortError" })
  await firstRequest
  await central.close()
  await rejection
  assert.equal(requests, 1)
})
