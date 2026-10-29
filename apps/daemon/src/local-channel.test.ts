import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test, { type TestContext } from "node:test"
import { openInMemoryCatalog, type NativeTerminal } from "@deskfleet/native"
import { DaemonClient } from "./control-client.ts"
import { MAX_LOCAL_MESSAGE_BYTES, type DaemonEvent } from "./control-protocol.ts"
import { startControlServer } from "./control-server.ts"
import type { PeerAuthorization } from "./central-protocol.ts"
import { TerminalSessions } from "./terminals.ts"
import { TestAgentQuotas } from "./fixtures/agent-quotas.ts"

type LocalMessage = Extract<DaemonEvent, { kind: "localChannelMessage" }>
type NativeEvent = Awaited<ReturnType<NativeTerminal["nextEvent"]>>
const token = "one-use-local-secret-at-least-32-characters"
const actor = { kind: "user" as const, userId: "user", deviceId: "device" }

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await delay(5)
  assert.equal(predicate(), true, "Expected channel activity")
}

class EchoTerminal {
  events: NativeEvent[] = []
  waiting?: (event: NativeEvent) => void
  closed = false
  resizes: number[][] = []
  emit(event: NativeEvent): void {
    if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve(event) }
    else this.events.push(event)
  }
  async nextEvent(): Promise<NativeEvent> {
    return this.events.length ? this.events.shift()! : new Promise(resolve => { this.waiting = resolve })
  }
  async write(data: Buffer): Promise<void> { this.emit({ kind: "data", data }) }
  async resize(cols: number, rows: number): Promise<void> { this.resizes.push([cols, rows]) }
  async close(): Promise<void> { this.closed = true; this.emit(null) }
}

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "df-local-channel-"))
  const replies = new Map<string, { result?: unknown; error?: { message: string } }>()
  let socket!: ControlSocket
  class ControlSocket extends EventTarget {
    static OPEN = 1
    readyState = ControlSocket.OPEN
    constructor() { super(); socket = this; queueMicrotask(() => this.dispatchEvent(new Event("open"))) }
    send(data: string): void {
      const message = JSON.parse(data) as { type: string; id: string; result?: unknown; error?: { message: string } }
      if (message.type === "response") replies.set(message.id, message)
    }
    close(): void { this.readyState = 3; this.dispatchEvent(new CloseEvent("close", { code: 1000 })) }
    receive(value: unknown): void { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })) }
  }
  context.mock.property(globalThis, "WebSocket", ControlSocket as unknown as typeof WebSocket)
  let identity = { originId: "", machineId: "" }
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).endsWith("/api/daemon/me")) return Response.json({ serverId: "server", machine: {
      id: "machine", teamId: "team", originId: identity.originId, localMachineId: identity.machineId,
    } })
    return Response.json({ lastEventSeq: "0" })
  })
  const native = new EchoTerminal()
  const terminals = new TerminalSessions({ directory: join(directory, "terminals"), factory: async () => native as NativeTerminal })
  let nativePeers = 0
  const daemon = await startControlServer({
    create: async () => { nativePeers++; throw new Error("WebRTC is disabled in this test") },
    close: async () => { throw new Error("Local channels must not close native peers") },
  }, directory, async () => ({ displays: [], audio: false }), terminals, undefined, undefined, undefined, {
    agentQuotas: new TestAgentQuotas(), openCatalog: (_path, name) => openInMemoryCatalog(name),
  })
  const clients: DaemonClient[] = []
  context.after(async () => {
    for (const client of clients) client.close()
    await daemon.close()
    await rm(directory, { recursive: true, force: true })
  })
  identity = daemon.central.status().identity
  await daemon.central.enroll({ serverUrl: "http://localhost:8080", teamId: "team", machineId: "machine", token: "machine-secret" })
  socket.receive({ type: "ready", serverId: "server", teamId: "team", machineId: "machine" })
  let requestId = 0
  const central = async (method: string, params: unknown) => {
    const id = String(++requestId)
    socket.receive({ type: "request", id, method, params, actor })
    await until(() => replies.has(id))
    const reply = replies.get(id)!
    assert.equal(reply.error, undefined, reply.error?.message)
    return reply.result
  }
  const prepare = async (peerId: string, purpose: "agent" | "terminal") => {
    const authorization: PeerAuthorization = {
      peerId, serverId: "server", teamId: "team", actor, transport: "local", purpose,
      targetMachine: { id: "machine", originId: identity.originId, localMachineId: identity.machineId },
      actions: purpose === "agent" ? ["agent:read", "agent:execute", "git:read"] : ["terminal:read", "terminal:write"],
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    await central("peer.local", { peerId, token, authorization })
  }
  const connect = async (autoAck = true) => {
    const events: DaemonEvent[] = []
    let client!: DaemonClient
    client = await DaemonClient.connect(event => {
      events.push(event)
      if (autoAck && event.kind === "localChannelMessage") void client.call("localAck", { peerId: event.peerId, sequence: event.sequence }).catch(() => {})
    }, () => {}, directory)
    clients.push(client)
    const messages = (peerId: string): LocalMessage[] => events.filter((event): event is LocalMessage => event.kind === "localChannelMessage" && event.peerId === peerId)
    const packets = (peerId: string): Record<string, unknown>[] => messages(peerId).flatMap(event =>
      Buffer.from(event.data, event.isString ? "utf8" : "base64").toString().trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>))
    const send = (peerId: string, message: unknown, isString = false) => {
      const bytes = Buffer.from(JSON.stringify(message) + (isString ? "" : "\n"))
      return client.call("localSend", { peerId, data: bytes.toString(isString ? "utf8" : "base64"), isString })
    }
    return { client, events, messages, packets, send }
  }
  return { daemon, central, prepare, connect, native, socket, nativePeers: () => nativePeers }
}

test("authenticated IPC carries Agent and terminal messages with WebRTC disabled and retains shells across reconnect", { timeout: 15_000 }, async context => {
  const f = await fixture(context)
  const a = await f.connect(), b = await f.connect()
  await assert.rejects(a.client.call("catalogList", {}), /backend API/)
  await assert.rejects(a.client.call("localOpen", { peerId: "unknown", token }), /Unknown authorized peer/)
  await f.prepare("agent", "agent")
  await a.client.call("localOpen", { peerId: "agent", token })
  await assert.rejects(b.client.call("localOpen", { peerId: "agent", token }), /unavailable/)
  await assert.rejects(b.send("agent", {}), /this connection/)
  await a.send("agent", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })
  await a.send("agent", { jsonrpc: "2.0", id: 2, method: "_deskfleet/session/list", params: {} })
  await until(() => a.packets("agent").some(packet => packet.id === 2))
  assert.deepEqual(a.packets("agent").find(packet => packet.id === 2)!.result, [])
  assert.ok(a.messages("agent").every(event => !event.isString))
  await assert.rejects(a.client.call("localSend", { peerId: "agent", isString: false, data: "invalid base64" }), /binary message/)
  await assert.rejects(a.client.call("localSend", { peerId: "agent", isString: true, data: "x".repeat(MAX_LOCAL_MESSAGE_BYTES + 1) }), /too large/)

  await f.central("terminalDial", { terminalId: "shell", mode: "create", cols: 80, rows: 24 })
  await f.prepare("terminal", "terminal")
  await a.client.call("localOpen", { peerId: "terminal", token })
  await a.send("terminal", { id: 1, method: "attach", params: { sessionId: "shell" } }, true)
  await until(() => a.packets("terminal").some(packet => packet.id === 1))
  await a.send("terminal", { id: 2, method: "input", params: { sessionId: "shell", data: Buffer.from("local echo").toString("base64") } }, true)
  await a.send("terminal", { id: 3, method: "resize", params: { sessionId: "shell", cols: 120, rows: 40 } }, true)
  const output = (packets: Record<string, unknown>[]) => packets.map(packet => packet.event as { kind?: string; data?: string; offset?: number }).filter(event => event?.kind === "output")
  await until(() => output(a.packets("terminal")).length > 0 && f.native.resizes.length > 0)
  assert.equal(Buffer.from(output(a.packets("terminal"))[0]!.data!, "base64").toString(), "local echo")
  assert.deepEqual(f.native.resizes, [[120, 40]])
  a.client.close()
  await until(() => f.daemon.terminals.list().some(terminal => terminal.id === "shell"))
  assert.equal(f.native.closed, false)

  await f.prepare("reconnected", "terminal")
  await b.client.call("localOpen", { peerId: "reconnected", token })
  await b.send("reconnected", { id: 1, method: "attach", params: { sessionId: "shell" } }, true)
  await until(() => output(b.packets("reconnected")).length > 0)
  assert.equal(Buffer.from(output(b.packets("reconnected"))[0]!.data!, "base64").toString(), "local echo")
  f.socket.close()
  await b.send("reconnected", { id: 2, method: "resize", params: { sessionId: "shell", cols: 100, rows: 30 } }, true)
  await until(() => f.native.resizes.length === 2)
  assert.equal(f.native.closed, false, "losing central signaling does not kill an authorized local channel or shell")
  assert.equal(f.nativePeers(), 0)
})

test("local delivery waits for the owning socket's acknowledgement and revocation frees a stalled viewer", { timeout: 10_000 }, async context => {
  const f = await fixture(context)
  const a = await f.connect(false), b = await f.connect()
  await f.prepare("agent", "agent")
  await a.client.call("localOpen", { peerId: "agent", token })
  await a.send("agent", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })
  await until(() => a.messages("agent").length === 1)
  await a.send("agent", { jsonrpc: "2.0", id: 2, method: "_deskfleet/session/list", params: {} })
  const first = a.messages("agent")[0]!
  await b.client.call("localAck", { peerId: "agent", sequence: first.sequence })
  await delay(20)
  assert.equal(a.messages("agent").length, 1, "another discovery socket cannot release output credit")
  await a.client.call("localAck", { peerId: "agent", sequence: first.sequence })
  await until(() => a.messages("agent").length === 2)
  f.socket.receive({ type: "peerRevoked", peerId: "agent" })
  await until(() => a.events.some(event => event.kind === "localChannelClosed" && event.peerId === "agent"))
  await assert.rejects(a.send("agent", {}), /this connection/)
  assert.equal(f.nativePeers(), 0)
})
