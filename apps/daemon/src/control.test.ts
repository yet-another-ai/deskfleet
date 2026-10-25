import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { connect, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createPeer, type NativePeer, type NativeTerminal, type PeerEvent } from "@deskfleet/native"
import { daemonDiscoveryPath, readDaemonDiscovery } from "./control-discovery.ts"
import type { ControlMessage, ControlMethod, ControlMethods, DaemonEvent } from "./control-protocol.ts"
import { validateControlParams, validateRelayedDesktopStart } from "./control-request.ts"
import { startControlServer as createControlServer, type ControlPeers } from "./control-server.ts"
import { startDaemon } from "./daemon.ts"
import { TerminalSessions } from "./terminals.ts"

function startControlServer(...args: Parameters<typeof createControlServer>) {
  args[7] = { ...args[7], allowLocalControlForTests: true }
  return createControlServer(...args)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

class Client {
  readonly socket: Socket
  readonly events: DaemonEvent[] = []
  readonly #pending = new Map<number, ReturnType<typeof deferred<unknown>>>()
  #id = 0
  #buffer = ""
  onEvent: ((event: DaemonEvent) => void) | undefined

  constructor(endpoint: string, signal?: AbortSignal) {
    this.socket = connect({ path: endpoint, signal })
    this.socket.setEncoding("utf8")
    this.socket.on("error", () => {})
    this.socket.on("data", (data: string) => {
      this.#buffer += data
      let end: number
      while ((end = this.#buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(this.#buffer.slice(0, end)) as ControlMessage
        this.#buffer = this.#buffer.slice(end + 1)
        if ("event" in message) {
          this.events.push(message.event)
          this.onEvent?.(message.event)
        } else {
          const waiting = this.#pending.get(message.id)
          this.#pending.delete(message.id)
          if (message.error) waiting?.reject(new Error(message.error))
          else waiting?.resolve(message.result)
        }
      }
    })
    this.socket.on("close", () => {
      for (const waiting of this.#pending.values()) waiting.reject(new Error("Connection closed"))
      this.#pending.clear()
    })
  }

  async call<M extends ControlMethod>(method: M, params: ControlMethods[M]["params"]): Promise<ControlMethods[M]["result"]> {
    return this.request(method, params) as Promise<ControlMethods[M]["result"]>
  }

  async request(method: unknown, params: unknown): Promise<unknown> {
    if (this.socket.destroyed) throw new Error("Connection closed")
    const id = ++this.#id
    const waiting = deferred<unknown>()
    this.#pending.set(id, waiting)
    this.socket.write(JSON.stringify({ id, method, params }) + "\n")
    return waiting.promise
  }

  close(): void { this.socket.destroy() }
}

function fakePeers() {
  const peers = new Map<string, { peer: NativePeer; closed: ReturnType<typeof deferred<void>> }>()
  const configCalls: unknown[] = []
  const answerCalls: string[] = []
  const candidateCalls: unknown[] = []
  const startCalls: unknown[] = []
  const service: ControlPeers = {
    async create(id, config) {
      configCalls.push(config)
      const closed = deferred<void>()
      let emitted = false
      const peer = {
        answerOffer: async (sdp: string) => { answerCalls.push(sdp); return "answer" },
        addIceCandidate: async (candidate: unknown) => { candidateCalls.push(candidate) },
        startDesktop: async (options: unknown) => { startCalls.push(options) },
        nextEvent: async (): Promise<PeerEvent | null> => {
          if (!emitted) { emitted = true; return { kind: "iceCandidate", candidate: { candidate: "native-ice" } } }
          await closed.promise
          return null
        },
      } as unknown as NativePeer
      peers.set(id, { peer, closed })
      return peer
    },
    async close(id) { peers.get(id)?.closed.resolve(); peers.delete(id) },
  }
  return { service, peers, configCalls, answerCalls, candidateCalls, startCalls }
}

const capabilities = async () => ({ displays: [{ id: 4, width: 1280, height: 720, refreshRateHz: 60 }], codecs: ["h264" as const], audio: false })
const offer = { sessionId: "screen-1", sdp: "browser-offer", codec: "h264" as const, audio: false }

test("local control authenticates before native calls and privately publishes discovery", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-control-test-"))
  const fake = fakePeers()
  const server = await startControlServer(fake.service, directory, capabilities)
  context.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }) })
  const discovery = await readDaemonDiscovery(directory)
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal((await stat(daemonDiscoveryPath(directory))).mode & 0o777, 0o600)
  }
  const unauthenticated = new Client(discovery.endpoint)
  context.after(() => unauthenticated.close())
  await assert.rejects(unauthenticated.call("offer", offer), /Authenticate/)
  assert.equal(fake.configCalls.length, 0)
  const unauthorizedShutdown = new Client(discovery.endpoint)
  context.after(() => unauthorizedShutdown.close())
  await assert.rejects(unauthorizedShutdown.call("shutdown", {}), /Authenticate/)
  const wrongToken = new Client(discovery.endpoint)
  context.after(() => wrongToken.close())
  await assert.rejects(wrongToken.call("hello", { token: "wrong" }), /authentication failed/)
  const client = new Client(discovery.endpoint)
  context.after(() => client.close())
  const info = await client.call("hello", { token: discovery.token })
  assert.ok(info.name)
  assert.deepEqual(await client.call("capabilities", {}), await capabilities())
  await assert.rejects(client.call("shutdown", {}), /shutdown is unavailable/)
  await assert.rejects(startControlServer(fake.service, directory, capabilities), /already running/)
  assert.deepEqual(await readDaemonDiscovery(directory), discovery)
})

test("desktop sessions belong to their IPC connection and close on disconnect", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-control-test-"))
  const fake = fakePeers()
  const server = await startControlServer(fake.service, directory, capabilities)
  context.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }) })
  const discovery = await readDaemonDiscovery(directory)
  const first = new Client(discovery.endpoint)
  const second = new Client(discovery.endpoint)
  context.after(() => { first.close(); second.close() })
  await Promise.all([first, second].map(client => client.call("hello", { token: discovery.token })))
  assert.deepEqual(await first.call("offer", offer), { sdp: "answer" })
  await second.call("offer", offer)
  assert.equal(fake.peers.size, 2)
  assert.deepEqual(fake.configCalls, [{ video: "h264", audio: false }, { video: "h264", audio: false }])
  assert.deepEqual(fake.answerCalls, ["browser-offer", "browser-offer"])
  await assert.rejects(first.call("offer", offer), /already exists/)
  assert.deepEqual(first.events, [{ sessionId: "screen-1", kind: "iceCandidate", candidate: { candidate: "native-ice" } }])
  await first.call("candidate", { sessionId: "screen-1", candidate: { candidate: "browser-ice", sdpMid: "0" } })
  assert.deepEqual(fake.candidateCalls, [{ candidate: "browser-ice", sdpMid: "0" }])
  await assert.rejects(second.call("candidate", { sessionId: "unknown", candidate: { candidate: "ice" } }), /Unknown desktop session/)
  await first.call("start", { sessionId: "screen-1", displayId: 4, fps: 30, bitrateBps: 8_000_000 })
  assert.deepEqual(fake.startCalls, [{ displayId: 4, fps: 30, bitrateBps: 8_000_000 }])
  const firstClosed = [...fake.peers.values()][0]!.closed.promise
  first.close()
  await firstClosed
  assert.equal(fake.peers.size, 1)
  await second.call("close", { sessionId: "screen-1" })
  assert.equal(fake.peers.size, 0)
  await second.call("close", { sessionId: "screen-1" })
  assert.deepEqual(await second.call("capabilities", {}), await capabilities())
})

test("stopping control waits for an executing request before releasing its resources", { timeout: 15_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-control-stop-"))
  const entered = deferred<void>()
  const release = deferred<void>()
  let completed = false
  const starting = startControlServer(fakePeers().service, directory, async () => {
    entered.resolve()
    await release.promise
    completed = true
    return capabilities()
  })
  context.after(async () => {
    release.resolve()
    try { await (await starting).close() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
  const server = await starting
  context.signal.throwIfAborted()
  const discovery = await readDaemonDiscovery(directory)
  const client = new Client(discovery.endpoint, context.signal)
  context.after(() => client.close())
  await client.call("hello", { token: discovery.token })
  const request = assert.rejects(client.call("capabilities", {}), /closed/)
  await entered.promise
  let stopped = false
  const stopping = server.stop().then(() => { stopped = true })
  await request
  assert.equal(stopped, false)
  assert.equal(completed, false)
  assert.deepEqual(await readDaemonDiscovery(directory), discovery)
  release.resolve()
  await stopping
  assert.equal(completed, true)
  assert.deepEqual(await readDaemonDiscovery(directory), discovery)
  await server.close()
  await assert.rejects(readDaemonDiscovery(directory), { code: "ENOENT" })
})

test("daemon control exchanges real native SDP and ICE without initializing capture", { timeout: 20_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-control-test-"))
  const daemon = await startDaemon(0, { allowLocalControlForTests: true, controlDirectory: directory, requestScreenCaptureAccess: async () => null })
  const peer = await createPeer({ video: "h264" })
  context.after(async () => { await peer.close(); await daemon.close(); await rm(directory, { recursive: true, force: true }) })
  const discovery = await readDaemonDiscovery(directory)
  const client = new Client(discovery.endpoint)
  context.after(() => client.close())
  await client.call("hello", { token: discovery.token })
  const answer = await client.call("offer", { ...offer, sdp: await peer.createOffer() })
  assert.match(answer.sdp, /H264\/90000/)
  await peer.acceptAnswer(answer.sdp)
  const connected = deferred<void>()
  const received = (event: DaemonEvent) => {
    if (event.kind === "iceCandidate") void peer.addIceCandidate(event.candidate).catch(connected.reject)
    if (event.kind === "stateChanged" && event.state === "connected") connected.resolve()
    if (event.kind === "error") connected.reject(new Error(event.error))
  }
  client.onEvent = received
  for (const event of client.events) received(event)
  const pump = (async () => {
    for (;;) {
      const event = await peer.nextEvent()
      if (!event) return
      if (event.kind === "iceCandidate") await client.call("candidate", { sessionId: offer.sessionId, candidate: event.candidate! })
      if (event.kind === "error") throw new Error(event.error)
    }
  })().catch(connected.reject)
  await connected.promise
  await client.call("close", { sessionId: offer.sessionId })
  await peer.close()
  await pump
  assert.equal((await fetch(`${daemon.address}/healthz`)).status, 200)
})

test("terminal signaling authenticates and creates a data-only peer with capture disabled", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-control-test-"))
  const fake = fakePeers()
  const server = await startControlServer(fake.service, directory, () => { throw new Error("Must not probe capture") })
  context.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }) })
  const discovery = await readDaemonDiscovery(directory)
  const unauthenticated = new Client(discovery.endpoint)
  context.after(() => unauthenticated.close())
  await assert.rejects(unauthenticated.call("terminalOffer", { sessionId: "terminal-1", sdp: "data-only-offer" }), /Authenticate/)
  assert.equal(fake.configCalls.length, 0)
  const client = new Client(discovery.endpoint)
  context.after(() => client.close())
  await client.call("hello", { token: discovery.token })
  assert.deepEqual(await client.call("terminalOffer", { sessionId: "terminal-1", sdp: "data-only-offer" }), { sdp: "answer" })
  assert.deepEqual(fake.configCalls, [{}])
  await assert.rejects(client.call("start", { sessionId: "terminal-1", displayId: 0 }), /cannot start desktop capture/)
  assert.equal(fake.startCalls.length, 0)
  await client.call("close", { sessionId: "terminal-1" })
  assert.equal(fake.peers.size, 0)
})

test("authenticated dial and hangup own independent shells even without a data peer", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-terminal-signaling-"))
  const spawned: Array<{ stopped: boolean; end: () => void }> = []
  const terminals = new TerminalSessions({ directory: join(directory, "terminals"), factory: async () => {
    const ended = deferred<void>()
    const process = { stopped: false, end: () => ended.resolve() }
    spawned.push(process)
    return {
      nextEvent: async () => { await ended.promise; return null },
      close: async () => { process.stopped = true; process.end() },
      write: async () => {},
      resize: async () => {},
    } as NativeTerminal
  } })
  const fake = fakePeers()
  const server = await startControlServer(fake.service, directory, capabilities, terminals)
  context.after(async () => { await server.close(); await terminals.close(); await rm(directory, { recursive: true, force: true }) })
  const discovery = await readDaemonDiscovery(directory)
  const blocked = new Client(discovery.endpoint)
  const observer = new Client(discovery.endpoint)
  const first = new Client(discovery.endpoint)
  const second = new Client(discovery.endpoint)
  context.after(() => { blocked.close(); observer.close(); first.close(); second.close() })
  const firstDial = { mode: "create" as const, terminalId: randomUUID(), cols: 80, rows: 24 }
  await assert.rejects(blocked.call("terminalDial", firstDial), /Authenticate/)
  assert.equal(spawned.length, 0)
  await Promise.all([first, second].map(client => client.call("hello", { token: discovery.token })))
  const shellA = await first.call("terminalDial", firstDial)
  assert.equal(shellA.id, firstDial.terminalId)
  assert.deepEqual(await first.call("terminalDial", firstDial), shellA)
  const shellB = await second.call("terminalDial", { ...firstDial, terminalId: randomUUID() })
  assert.equal(spawned.length, 2)
  assert.equal(fake.configCalls.length, 0)
  await assert.rejects(startControlServer(fake.service, directory, capabilities), /already running/)
  const metadata = JSON.parse(await readFile(join(directory, "terminals", shellA.id, "session.json"), "utf8")) as { terminal: { status: string } }
  assert.equal(metadata.terminal.status, "running")
  assert.equal(spawned[0]!.stopped, false)
  assert.equal((await second.call("terminalList", {})).length, 2)
  assert.ok(second.events.some(event => event.kind === "terminalChanged" && event.terminal.id === shellA.id))
  assert.deepEqual(observer.events, [])
  first.close()
  assert.equal((await second.call("terminalDial", { mode: "resume", terminalId: shellA.id })).id, shellA.id)
  assert.equal(spawned.length, 2)
  assert.equal(spawned[0]!.stopped, false)
  await second.call("terminalHangup", { terminalId: shellA.id })
  assert.equal(spawned[0]!.stopped, true)
  assert.equal(spawned[1]!.stopped, false)
  assert.deepEqual((await second.call("terminalList", {})).map(terminal => terminal.id), [shellB.id])
  await assert.rejects(stat(join(directory, "terminals", shellA.id)), { code: "ENOENT" })
  await assert.rejects(second.call("terminalDial", { mode: "resume", terminalId: shellA.id }), /Unknown terminal/)
  assert.ok(second.events.some(event => event.kind === "terminalHungup" && event.terminalId === shellA.id))
})

test("a stale discovery record can be replaced and is removed at shutdown", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-control-test-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const path = daemonDiscoveryPath(directory)
  const endpoint = process.platform === "win32" ? "\\\\.\\pipe\\deskfleet-does-not-exist" : join(directory, "missing.sock")
  await writeFile(path, JSON.stringify({ endpoint, token: "a".repeat(64) }))
  const server = await startControlServer(fakePeers().service, directory, capabilities)
  assert.notEqual((await readDaemonDiscovery(directory)).token, "a".repeat(64))
  await server.close()
  await assert.rejects(readFile(path), { code: "ENOENT" })
})

test("local control rejects malformed native settings before crossing the binding", () => {
  assert.throws(() => validateControlParams("offer", { ...offer, codec: "vp8" }), /codec/)
  assert.throws(() => validateControlParams("start", { sessionId: "screen", displayId: 1, fps: 0 }), /frame rate/)
  assert.throws(() => validateControlParams("start", { sessionId: "screen", displayId: -1 }), /display ID/)
  assert.throws(() => validateControlParams("candidate", { sessionId: "screen", candidate: { candidate: "ice", sdpMlineIndex: 1.5 } }), /media index/)
})

test("relayed desktop starts treat JSON null as an omitted option and validate the rest", () => {
  // The backend forwards a client's omitted fps and bitrate as null.
  assert.deepEqual(validateRelayedDesktopStart({ peerId: "peer", displayId: 1, fps: null, bitrateBps: null }), { displayId: 1, fps: undefined, bitrateBps: undefined })
  assert.deepEqual(validateRelayedDesktopStart({ peerId: "peer", displayId: 2, fps: 30, bitrateBps: 8_000_000 }), { displayId: 2, fps: 30, bitrateBps: 8_000_000 })
  assert.throws(() => validateRelayedDesktopStart({ peerId: "peer", displayId: null }), /display ID/)
  assert.throws(() => validateRelayedDesktopStart({ peerId: "peer", displayId: 1, fps: 0 }), /frame rate/)
  assert.throws(() => validateRelayedDesktopStart({ peerId: "peer", displayId: 1, bitrateBps: "fast" }), /bitrate/)
})

test("directory browsing requires authentication and uses the daemon filesystem without a peer", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-folder-control-"))
  const folders = join(directory, "folders")
  await mkdir(join(folders, "project"), { recursive: true })
  await writeFile(join(folders, "file.txt"), "file")
  const fake = fakePeers()
  const server = await startControlServer(fake.service, directory, () => { throw new Error("Must not probe capture") })
  context.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }) })
  const discovery = await readDaemonDiscovery(directory)
  const blocked = new Client(discovery.endpoint)
  const client = new Client(discovery.endpoint)
  context.after(() => { blocked.close(); client.close() })
  await assert.rejects(blocked.call("directoryList", { path: folders }), /Authenticate/u)
  await client.call("hello", { token: discovery.token })
  const listing = await client.call("directoryList", { path: folders })
  assert.equal(listing.path, folders)
  assert.deepEqual(listing.directories, [{ name: "project", path: join(folders, "project"), hidden: false }])
  await assert.rejects(client.call("directoryList", { path: "relative" }), /absolute path/u)
  assert.equal((await client.call("directoryList", { path: folders })).path, folders)
  assert.deepEqual(client.events, [])
  assert.deepEqual(fake.configCalls, [])
})

test("request validation errors retain authenticated connections and their active peers", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-control-validation-"))
  const fake = fakePeers()
  const server = await startControlServer(fake.service, directory, capabilities)
  context.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }) })
  const discovery = await readDaemonDiscovery(directory)
  const client = new Client(discovery.endpoint)
  context.after(() => client.close())
  await client.call("hello", { token: discovery.token })
  await client.call("offer", offer)
  await assert.rejects(client.request("futureOperation", {}), /Unknown local daemon operation: futureOperation/u)
  assert.deepEqual(await client.call("capabilities", {}), await capabilities())
  await assert.rejects(client.request("directoryList", { path: 42 }), /Invalid directory path/u)
  await assert.rejects(client.request("start", null), /Expected an object/u)
  assert.equal(fake.peers.size, 1)
  await client.call("start", { sessionId: offer.sessionId, displayId: 4 })
  assert.deepEqual(fake.startCalls, [{ displayId: 4, fps: undefined, bitrateBps: undefined }])
  await client.call("close", { sessionId: offer.sessionId })
  assert.equal(fake.peers.size, 0)
})

test("invalid framing and request IDs still disconnect, as do unauthenticated validation errors", { timeout: 15_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-control-framing-"))
  const fake = fakePeers()
  const starting = startControlServer(fake.service, directory, capabilities)
  context.after(async () => {
    try { await (await starting).close() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
  await starting
  context.signal.throwIfAborted()
  const discovery = await readDaemonDiscovery(directory)
  for (const payload of ["{invalid json}\n", JSON.stringify({ id: "1", method: "capabilities", params: {} }) + "\n"]) {
    const client = new Client(discovery.endpoint, context.signal)
    context.after(() => client.close())
    await client.call("hello", { token: discovery.token })
    await client.call("offer", offer)
    const peerClosed = [...fake.peers.values()][0]!.closed.promise
    const socketClosed = once(client.socket, "close", { signal: context.signal })
    client.socket.write(payload)
    await Promise.all([socketClosed, peerClosed])
    assert.equal(fake.peers.size, 0)
  }
  const unauthenticated = new Client(discovery.endpoint, context.signal)
  context.after(() => unauthenticated.close())
  const closed = once(unauthenticated.socket, "close", { signal: context.signal })
  await assert.rejects(unauthenticated.request("hello", { token: null }), /Missing authentication token/u)
  await closed
})
