import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createPeer, type NativePeer } from "@deskfleet/native"
import { MuxConnection } from "../../../packages/client/src/mux/connection.ts"
import { MUX_LABELS, muxLane, type MuxLane } from "../../../packages/client/src/mux/protocol.ts"
import { FilesRpcClient } from "../../../packages/client/src/files-rpc.ts"
import { FILE_CHUNK_BYTES } from "./files-protocol.ts"
import { AuthorizedPeers } from "./authorized-peers.ts"
import type { AgentChannelSessions } from "./agent-channel.ts"
import type { PeerAuthorization, PeerSignal } from "./central-protocol.ts"
import type { TerminalSessions } from "./terminals.ts"

test("native WebRTC carries multiple Agent and terminal streams on exactly four shared channels", { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-mux-rtc-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, "bulk.bin")
  const contents = Buffer.from(Array.from({ length: FILE_CHUNK_BYTES * 8 }, (_, index) => index % 251))
  await writeFile(file, contents)
  const client = await createPeer({})
  const errors: unknown[] = [], opened = new Set<string>(), used = new Set<MuxLane>()
  let native: NativePeer | undefined, created = 0, closing = false, remoteReady = false
  let remoteAdding = Promise.resolve()
  const pendingIce: Extract<PeerSignal, { kind: "iceCandidate" }>["candidate"][] = []
  function addRemoteCandidates(): void {
    if (!remoteReady || closing) return
    for (const candidate of pendingIce.splice(0)) {
      remoteAdding = remoteAdding.then(async () => { if (!closing) await client.addIceCandidate(candidate) }).catch(error => { if (!closing) errors.push(error) })
    }
  }
  const agents: AgentChannelSessions = {
    journal: { identity: { originId: "origin", machineId: "1" } }, onEvent: () => () => {},
    handle: async (_method, _params, actor) => [{ deviceId: actor.deviceId }],
  }
  const history = Buffer.from("Mux terminal history\r\n")
  const summary = { id: "shell", title: "Shell", cwd: "/", cols: 80, rows: 24, status: "running", kind: "acp" }
  const terminals = {
    list: () => [summary], snapshot: () => ({ summary, end: history.length }),
    read: async (_id: string, offset: number, length: number) => history.subarray(offset, offset + length),
    subscribe: () => () => {}, release: () => {}, claim: () => {},
  } as unknown as TerminalSessions
  const server = new AuthorizedPeers({
    peers: {
      create: async (_id, config) => { created++; native = await createPeer(config); return native },
      close: async () => { await native?.close() },
    }, agents, terminals, identity: { originId: "origin", machineId: "1" },
    signal: (_id, event) => {
      if (event.kind === "iceCandidate") { pendingIce.push(event.candidate); addRemoteCandidates() }
      else if (event.kind === "error" && !closing) errors.push(new Error(event.error))
    },
  })
  server.bind({ serverUrl: "https://backend.test", serverId: "server", teamId: "team", machineId: "machine", token: "token" })
  const mux = new MuxConnection({
    role: "client",
    async send(lane, bytes) {
      const deadline = Date.now() + 5_000
      for (;;) {
        if (closing) throw new Error("Test connection closed")
        try { await client.sendData(MUX_LABELS[lane], Buffer.from(bytes)); return }
        catch (error) {
          if (!/backpressure|send buffer is full/iu.test(String(error)) || Date.now() >= deadline) throw error
          await delay(10)
        }
      }
    },
    failed: error => { if (!closing) errors.push(error) },
  })
  let pumping: Promise<void> | undefined
  t.after(async () => {
    closing = true; mux.close()
    await Promise.all([server.closeAll(), client.close()])
    await Promise.all([pumping, remoteAdding])
  })
  for (const label of Object.values(MUX_LABELS)) await client.createDataChannel(label)
  const now = Date.now()
  const authorization: PeerAuthorization = {
    peerId: "mux", serverId: "server", teamId: "team", purpose: "mux", transport: "webrtc",
    actor: { kind: "user", userId: "user", deviceId: "login" },
    targetMachine: { id: "machine", originId: "origin", localMachineId: "1" },
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    actions: ["agent:read", "agent:execute", "git:read", "terminal:read", "terminal:write", "files:read", "files:write"],
  }
  const offer = await client.createOffer()
  const answer = await server.offer({ peerId: "mux", sdp: offer, authorization, iceServers: [] })
  await client.acceptAnswer(answer.sdp)
  remoteReady = true; addRemoteCandidates()
  pumping = (async () => {
    while (!closing) {
      const event = await client.nextEvent()
      if (!event || closing) return
      if (event.kind === "iceCandidate" && event.candidate) await server.candidate("mux", event.candidate)
      else if (event.kind === "dataChannelOpen" && event.label) opened.add(event.label)
      else if (event.kind === "data" && event.label && event.data) {
        const lane = muxLane(event.label)
        assert.ok(lane); assert.equal(event.isString, false)
        used.add(lane); mux.receive(lane, event.data)
      } else if (event.kind === "error") throw new Error(event.error)
    }
  })().catch(error => { if (!closing) errors.push(error) })
  async function until(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 2_000; attempt++) {
      if (errors.length) throw errors[0]
      if (predicate()) return
      await delay(5)
    }
    throw new Error("Timed out waiting for native Mux data")
  }
  await until(() => opened.size === 4)
  let unblockBulk!: () => void, bulkStarted = false
  const bulkGate = new Promise<void>(resolve => { unblockBulk = resolve })
  const files = new FilesRpcClient(async (receive, failed) => {
    const stream = mux.open("files")
    stream.onClose = error => failed(error ?? new Error("File stream closed"))
    stream.onData = async data => {
      assert.ok(data instanceof Uint8Array)
      bulkStarted = true
      await bulkGate
      receive(data)
    }
    await stream.ready
    return { send: bytes => stream.send(bytes), close: async () => { stream.close() } }
  })
  t.after(async () => { unblockBulk(); await files.close() })
  const reads = Array.from({ length: 8 }, (_, index) => files.call("read", { path: file, offset: index * FILE_CHUNK_BYTES, length: FILE_CHUNK_BYTES }))
  const downloaded = Promise.all(reads)
  void downloaded.catch(() => {})
  await until(() => bulkStarted)
  const first = mux.open("agent"), second = mux.open("agent"), terminal = mux.open("terminal")
  const replies = [[], []] as { id: number; result?: unknown }[][]
  for (const [index, stream] of [first, second].entries()) {
    let text = ""
    stream.onData = data => {
      assert.ok(data instanceof Uint8Array)
      text += Buffer.from(data).toString()
      for (let newline = text.indexOf("\n"); newline >= 0; newline = text.indexOf("\n")) {
        replies[index]!.push(JSON.parse(text.slice(0, newline))); text = text.slice(newline + 1)
      }
    }
  }
  const terminalEvents: { kind: string; data?: string }[] = []
  terminal.onData = data => {
    const message = JSON.parse(String(data))
    if (message.event) terminalEvents.push(message.event)
    if (message.event?.kind === "output") void terminal.send(JSON.stringify({ ack: { sessionId: "shell", offset: message.event.offset } }))
  }
  await Promise.all([first.ready, second.ready, terminal.ready])
  const rpc = (id: number, method: string, params: unknown = {}) => Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  await Promise.all([first.send(rpc(1, "initialize", { protocolVersion: 1 })), second.send(rpc(1, "initialize", { protocolVersion: 1 }))])
  await until(() => replies.every(values => values.some(value => value.id === 1)))
  await Promise.all([first.send(rpc(2, "_deskfleet/session/list")), second.send(rpc(2, "_deskfleet/session/list")), terminal.send(JSON.stringify({ id: 1, method: "attach", params: { sessionId: "shell" } }))])
  await until(() => replies.every(values => values.some(value => value.id === 2)) && terminalEvents.some(event => event.kind === "ready"))
  assert.deepEqual(replies.map(values => values.find(value => value.id === 2)!.result), [[{ deviceId: "login" }], [{ deviceId: "login" }]])
  assert.deepEqual(terminalEvents.map(event => event.kind), ["reset", "output", "ready"])
  assert.equal(Buffer.from(terminalEvents[1]!.data!, "base64").toString(), history.toString())
  // The bulk consumer is still blocked; its exhausted window must not stop
  // Agent requests or another terminal's replay/ready transition.
  unblockBulk()
  assert.deepEqual(Buffer.concat((await downloaded).map(reply => Buffer.from(reply.data!))), contents)
  first.close()
  await second.send(rpc(3, "_deskfleet/session/list"))
  await until(() => replies[1]!.some(value => value.id === 3))
  assert.equal(created, 1)
  assert.deepEqual(new Set(opened), new Set(Object.values(MUX_LABELS)))
  assert.deepEqual(used, new Set(["control", "agent", "terminal", "bulk"]))
  assert.deepEqual(errors, [])
})
