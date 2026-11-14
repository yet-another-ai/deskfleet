import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { connect, type Socket } from "node:net"
import { join } from "node:path"
import type { Duplex } from "node:stream"
import { app, session } from "electron"
import { HttpCentralClient, type SavedAccount } from "@deskfleet/client/http-central"
import { desktopCentralTransport } from "../../src/main/central-transport.ts"

process.on("message", () => app.quit())
process.on("disconnect", () => app.quit())

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return address.port
}

async function smoke() {
  const reserved = createServer()
  const backendPort = await listen(reserved)
  await new Promise<void>(resolve => reserved.close(() => resolve()))
  const serverUrl = `http://127.0.0.1:${backendPort}`
  await assert.rejects(fetch(`${serverUrl}/api/auth/start`, { method: "POST", signal: AbortSignal.timeout(3_000) }),
    (error: unknown) => error instanceof TypeError && (error.cause as NodeJS.ErrnoException)?.code === "ECONNREFUSED")

  const user = { id: "proxy-user", name: "Proxy smoke" }
  const requests: string[] = []
  const sockets = new Set<Socket | Duplex>()
  let proxyRequests = 0
  let authenticated = false
  let repliedToPing!: () => void
  const pong = new Promise<void>(resolve => { repliedToPing = resolve })
  let fail!: (error: unknown) => void
  const failed = new Promise<never>((_resolve, reject) => { fail = reject })
  const api = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url!, serverUrl)
      assert.equal(url.origin, serverUrl)
      assert.equal(request.headers.cookie, undefined, "Desktop bearer requests must omit session cookies")
      requests.push(`${request.method} ${url.pathname}`)
      let body = ""
      for await (const chunk of request) body += String(chunk)
      let result: unknown
      if (url.pathname === "/api/auth/start") {
        assert.equal(request.method, "POST")
        assert.deepEqual(JSON.parse(body), { returnTo: "http://127.0.0.1/auth/callback" })
        result = { authorizationUrl: `${serverUrl}/auth/authorize`, loginVerifier: "proxy-verifier" }
      } else if (url.pathname === "/api/auth/exchange") {
        assert.equal(request.method, "POST")
        assert.deepEqual(JSON.parse(body), { code: "proxy-code", loginVerifier: "proxy-verifier" })
        result = { token: "proxy-token", user }
      } else if (url.pathname === "/api/me") {
        assert.equal(request.headers.authorization, "Bearer proxy-token")
        result = { user, siteAdmin: false }
      } else {
        assert.equal(url.pathname, "/api/daemon/me")
        assert.equal(request.headers.authorization, "Bearer machine-token")
        result = { machine: "proxy-machine" }
      }
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(result))
    } catch (error) { response.writeHead(500).end(); fail(error) }
  }
  const backend = createServer((request, response) => { void api(request, response) })
  const proxy = createServer((request, response) => { proxyRequests++; void api(request, response) })
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      assert.equal(new URL(request.url!, serverUrl).pathname, "/api/client/ws")
      assert.equal(request.headers.cookie, undefined, "The signaling socket must omit session cookies")
      const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      let received = head
      const send = (message: unknown) => {
        const body = Buffer.from(JSON.stringify(message))
        assert.ok(body.length < 126)
        socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]))
      }
      socket.on("data", (chunk: Buffer) => {
        try {
          received = Buffer.concat([received, chunk])
          while (received.length >= 2) {
            const opcode = received[0]! & 0x0f
            const length = received[1]! & 0x7f
            assert.ok(length < 126, "Smoke frames fit the short WebSocket frame format")
            assert.ok(received[1]! & 0x80, "Client frames are masked")
            if (received.length < 6 + length) return
            const body = Buffer.from(received.subarray(6, 6 + length))
            for (let index = 0; index < length; index++) body[index] = body[index]! ^ received[2 + index % 4]!
            received = received.subarray(6 + length)
            if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return }
            assert.equal(opcode, 1)
            const message = JSON.parse(body.toString())
            if (!authenticated) {
              assert.deepEqual(message, { type: "authenticate", token: "proxy-token" })
              authenticated = true
              send({ type: "ready" })
              send({ type: "machinesChanged", teamId: "proxy-team" })
              send({ type: "ping" })
            } else {
              assert.deepEqual(message, { type: "pong" })
              repliedToPing()
            }
          }
        } catch (error) { fail(error) }
      })
    } catch (error) { socket.destroy(); fail(error) }
  }
  backend.on("upgrade", upgrade)
  proxy.on("upgrade", (request, socket, head) => { proxyRequests++; upgrade(request, socket, head) })
  for (const server of [backend, proxy]) server.on("connection", socket => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  const actualPort = await listen(backend)
  proxy.on("connect", (request, socket, head) => {
    proxyRequests++
    try {
      assert.equal(request.url, `127.0.0.1:${backendPort}`)
      const upstream = connect(actualPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        if (head.length) upstream.write(head)
        socket.pipe(upstream).pipe(socket)
      })
      sockets.add(upstream)
      upstream.once("close", () => sockets.delete(upstream))
      upstream.on("error", fail)
    } catch (error) { socket.destroy(); fail(error) }
  })
  const proxyPort = await listen(proxy)
  let saved: SavedAccount | undefined
  const client = new HttpCentralClient({
    account: { serverUrl }, ...desktopCentralTransport,
    persist: async account => { saved = account }, authorize: async () => {},
  })
  const events: unknown[] = []
  let changed!: () => void
  const machineEvent = new Promise<void>(resolve => { changed = resolve })
  client.onEvent(event => {
    events.push(event)
    if (event.type === "machinesChanged") changed()
  })
  try {
    // Configure only this isolated Electron profile; the user's OS proxy is untouched.
    await session.defaultSession.setProxy({ mode: "fixed_servers", proxyRules: `http://127.0.0.1:${proxyPort}`, proxyBypassRules: "<-loopback>" })
    assert.equal(await session.defaultSession.resolveProxy(serverUrl), `PROXY 127.0.0.1:${proxyPort}`)
    await session.defaultSession.cookies.set({ url: serverUrl, name: "unrelated-session", value: "must-not-be-sent" })
    await Promise.race([failed, (async () => {
      assert.deepEqual(await client.authorizationUrl("http://127.0.0.1/auth/callback"), {
        authorizationUrl: `${serverUrl}/auth/authorize`, loginVerifier: "proxy-verifier",
      })
      await client.exchange("proxy-code", "proxy-verifier")
      assert.deepEqual(saved, { serverUrl, token: "proxy-token", user })
      assert.deepEqual(await client.status(), { serverUrl, user, siteAdmin: false })
      // Daemon requests use Fetch's default credentials value, unlike the account client.
      const machine = await desktopCentralTransport.fetch!(new Request(`${serverUrl}/api/daemon/me`, {
        headers: { Authorization: "Bearer machine-token" },
      }))
      assert.deepEqual(await machine.json(), { machine: "proxy-machine" })
      await Promise.all([machineEvent, pong])
    })()])
    assert.ok(authenticated)
    assert.ok(events.some(event => JSON.stringify(event) === JSON.stringify({ type: "connection", connected: true })))
    assert.deepEqual(requests, ["POST /api/auth/start", "POST /api/auth/exchange", "GET /api/me", "GET /api/daemon/me"])
    assert.ok(proxyRequests >= 5, "Both HTTP and signaling must pass through the proxy")
    return { electron: process.versions.electron, platform: process.platform, directFailure: "ECONNREFUSED", requests, proxyRequests, authenticated, events }
  } finally {
    client.dispose()
    for (const socket of sockets) socket.destroy()
    await Promise.all([backend, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  }
}

void app.whenReady().then(smoke).then(async result => {
  await writeFile(join(import.meta.dirname, "results.json"), JSON.stringify(result, null, 2) + "\n")
  process.send?.({ result })
}).catch(error => { process.send?.({ error: error instanceof Error ? error.stack : String(error) }); app.quit() })
