import { afterEach, expect, test, vi } from "vitest"
import { MuxConnection, type MuxStream } from "./connection.ts"
import { MUX_FRAME_BYTES, MUX_HEADER_BYTES, MUX_LABELS, MUX_MAX_STREAMS, MUX_STREAM_QUEUE_BYTES, MUX_WINDOW_BYTES, decodeMuxFrame, encodeMuxControl, encodeMuxFrame, muxFrameCost, type MuxLane } from "./protocol.ts"

const connections: MuxConnection[] = []
afterEach(() => { for (const connection of connections.splice(0)) connection.close() })
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(ready => { resolve = ready })
  return { promise, resolve }
}
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve() }
interface Packet { from: "client" | "server"; lane: MuxLane; data: Uint8Array }
function pair(options: { accept?: (stream: MuxStream) => void; send?: (packet: Packet, deliver: () => void) => void | Promise<void> } = {}) {
  const accepted: MuxStream[] = [], packets: Packet[] = [], clientFailure = vi.fn(), serverFailure = vi.fn()
  let client!: MuxConnection, server!: MuxConnection
  const send = async (from: Packet["from"], lane: MuxLane, data: Uint8Array) => {
    const packet = { from, lane, data: data.slice() }; packets.push(packet)
    const deliver = () => (from === "client" ? server : client).receive(lane, data)
    if (options.send) await options.send(packet, deliver)
    else deliver()
  }
  client = new MuxConnection({ role: "client", send: (lane, bytes) => send("client", lane, bytes), failed: clientFailure })
  server = new MuxConnection({ role: "server", send: (lane, bytes) => send("server", lane, bytes), accept: stream => {
    accepted.push(stream); options.accept?.(stream)
  }, failed: serverFailure })
  connections.push(client, server)
  return { client, server, accepted, packets, clientFailure, serverFailure }
}

test("many logical streams use only the four fixed lanes and close independently", async () => {
  const fixture = pair({ accept: stream => { stream.onData = data => stream.send(data) } })
  const streams = [...Array.from({ length: 12 }, () => fixture.client.open("terminal")), fixture.client.open("agent"), fixture.client.open("files")]
  await Promise.all(streams.map(stream => stream.ready))
  const received: (string | Uint8Array)[] = []
  for (const stream of streams) stream.onData = data => { received.push(data) }
  await Promise.all(streams.map(stream => stream.send(stream.purpose === "files" ? new Uint8Array([1, 2, 3]) : `hello-${stream.id}`)))
  await vi.waitFor(() => expect(received).toHaveLength(streams.length))
  expect(Object.keys(MUX_LABELS)).toEqual(["control", "terminal", "agent", "bulk"])
  expect(new Set(fixture.packets.map(packet => packet.lane))).toEqual(new Set(Object.keys(MUX_LABELS)))
  streams[0]!.close()
  await settle()
  expect(fixture.client.streamCount).toBe(13)
  expect(fixture.server.streamCount).toBe(13)
  expect(fixture.client.closed).toBe(false)
  await streams[1]!.send("still connected")
  await vi.waitFor(() => expect(received).toContain("still connected"))
  expect(fixture.clientFailure).not.toHaveBeenCalled()
  expect(fixture.serverFailure).not.toHaveBeenCalled()
})

test("fragments 64 KiB messages into bounded frames and retains text/binary boundaries", async () => {
  const received: (string | Uint8Array)[] = []
  const fixture = pair({ accept: stream => { stream.onData = data => { received.push(data) } } })
  const stream = fixture.client.open("files")
  await stream.ready
  const bytes = Uint8Array.from({ length: 65536 }, (_, i) => i % 256)
  await stream.send(bytes)
  await stream.send("")
  await vi.waitFor(() => expect(received).toEqual([bytes, ""]))
  expect(fixture.packets.filter(packet => packet.lane === "bulk").every(packet => packet.data.length <= MUX_FRAME_BYTES)).toBe(true)
  await expect(stream.send(new Uint8Array(65537))).rejects.toThrow("64 KiB")
})

test("cross-lane replay and live frames are delivered in stream order", async () => {
  const delayed: (() => void)[] = [], received: (string | Uint8Array)[] = []
  const fixture = pair({
    accept: stream => { stream.onData = data => { received.push(data) } },
    send: (packet, deliver) => { if (packet.lane === "bulk") delayed.push(deliver); else deliver() },
  })
  const stream = fixture.client.open("terminal")
  await stream.ready
  await stream.send("history".repeat(6000), "bulk")
  await stream.send("ready", "terminal")
  await stream.send("live", "terminal")
  await settle()
  expect(received).toEqual([])
  for (const deliver of delayed) deliver()
  await vi.waitFor(() => expect(received).toEqual(["history".repeat(6000), "ready", "live"]))
  expect(fixture.serverFailure).not.toHaveBeenCalled()
})

test("consumer ACK pressure stalls one stream while siblings remain usable", async () => {
  const consumed = deferred(), delivered: number[] = [], echoed: (string | Uint8Array)[] = []
  const fixture = pair({ accept: stream => {
    stream.onData = async data => {
      if (stream.purpose === "files") { delivered.push((data as Uint8Array).length); await consumed.promise }
      else await stream.send(data)
    }
  } })
  const files = fixture.client.open("files"), terminal = fixture.client.open("terminal")
  await Promise.all([files.ready, terminal.ready])
  terminal.onData = data => { echoed.push(data) }
  const sending = Array.from({ length: 8 }, () => files.send(new Uint8Array(32768)))
  await settle()
  const bulk = fixture.packets.filter(packet => packet.from === "client" && packet.lane === "bulk")
  expect(bulk.reduce((sum, packet) => sum + muxFrameCost(packet.data.length), 0)).toBeLessThanOrEqual(MUX_WINDOW_BYTES)
  expect(files.bufferedAmount).toBeGreaterThan(0)
  await terminal.send("responsive")
  await vi.waitFor(() => expect(echoed).toEqual(["responsive"]))
  consumed.resolve()
  await Promise.all(sending)
  await vi.waitFor(() => expect(delivered).toHaveLength(8))
  expect(files.bufferedAmount).toBe(0)
})

test("a delayed small message does not exhaust reassembly by later declared message sizes", async () => {
  const delayed: (() => void)[] = [], received: (string | Uint8Array)[] = []
  const fixture = pair({
    accept: stream => { stream.onData = data => { received.push(data) } },
    send: (packet, deliver) => { if (packet.lane === "bulk") delayed.push(deliver); else deliver() },
  })
  const stream = fixture.client.open("agent")
  await stream.ready
  await stream.send("a", "bulk")
  const sends = [stream.send(new Uint8Array(65536)), stream.send(new Uint8Array(65536))]
  await settle()
  expect(fixture.serverFailure).not.toHaveBeenCalled()
  expect(received).toEqual([])
  for (const deliver of delayed) deliver()
  await Promise.all(sends)
  await vi.waitFor(() => expect(received).toHaveLength(3))
})

test("round-robin scheduling interleaves frames from competing bulk streams", async () => {
  const fixture = pair({ accept: stream => { stream.onData = () => {} } })
  const first = fixture.client.open("files"), second = fixture.client.open("files")
  await Promise.all([first.ready, second.ready])
  await Promise.all([first.send(new Uint8Array(65536)), second.send(new Uint8Array(65536))])
  const ids = fixture.packets.filter(packet => packet.from === "client" && packet.lane === "bulk").map(packet => decodeMuxFrame(packet.data).id)
  expect(ids.slice(0, 4)).toEqual([first.id, second.id, first.id, second.id])
})

test("retains early messages until the adapter installs its receiver", async () => {
  const fixture = pair({ accept: stream => { void stream.send("early response") } })
  const stream = fixture.client.open("agent")
  await stream.ready
  await settle()
  const received: (string | Uint8Array)[] = []
  stream.onData = data => { received.push(data) }
  await vi.waitFor(() => expect(received).toEqual(["early response"]))
})

test("closing before the open response cleans up both sides and ignores late frames", async () => {
  const delayed: (() => void)[] = []
  const fixture = pair({ send: (packet, deliver) => {
    if (packet.from === "server") delayed.push(deliver)
    else deliver()
  } })
  const stream = fixture.client.open("terminal")
  const ready = expect(stream.ready).rejects.toThrow("closed")
  stream.close()
  await ready
  await settle()
  for (const deliver of delayed) deliver()
  fixture.client.receive("terminal", encodeMuxFrame({ id: stream.id, sequence: 0, offset: 0, total: 1, text: false, data: new Uint8Array([1]) }))
  expect(fixture.client.streamCount).toBe(0)
  expect(fixture.server.streamCount).toBe(0)
  expect(fixture.clientFailure).not.toHaveBeenCalled()
})

test("admission and consumer failures close only their logical stream", async () => {
  const fixture = pair({ accept: stream => {
    if (stream.purpose === "files") throw new Error("Files are not authorized")
    stream.onData = data => {
      if (data === "invalid") throw new Error("Invalid terminal request")
      return stream.send(data)
    }
  } })
  const agent = fixture.client.open("agent"), files = fixture.client.open("files")
  await expect(files.ready).rejects.toThrow("not authorized")
  await agent.ready
  const received: (string | Uint8Array)[] = []
  agent.onData = data => { received.push(data) }
  await agent.send("valid")
  await vi.waitFor(() => expect(received).toEqual(["valid"]))
  const terminal = fixture.client.open("terminal")
  await terminal.ready
  await terminal.send("invalid")
  await vi.waitFor(() => expect(terminal.state).toBe("closed"))
  expect(agent.state).toBe("open")
  expect(fixture.clientFailure).not.toHaveBeenCalled()
  expect(fixture.serverFailure).not.toHaveBeenCalled()
})

test("queued sends reject on closure and release all byte accounting", async () => {
  const blocked = deferred()
  const fixture = pair({ send: async (packet, deliver) => {
    if (packet.lane !== "control") await blocked.promise
    deliver()
  } })
  const stream = fixture.client.open("files")
  await stream.ready
  const pending = Array.from({ length: 15 }, () => stream.send(new Uint8Array(65536)).catch(error => error))
  expect(stream.bufferedAmount).toBeLessThanOrEqual(MUX_STREAM_QUEUE_BYTES)
  await expect(stream.send(new Uint8Array(65536))).rejects.toThrow("queue is full")
  stream.close()
  const result = await Promise.all(pending)
  expect(result.every(value => value instanceof Error)).toBe(true)
  expect(stream.bufferedAmount).toBe(0)
  expect(fixture.client.bufferedAmount).toBe(0)
  blocked.resolve()
  await settle()
  expect(fixture.serverFailure).not.toHaveBeenCalled()
})

test("protocol errors close the whole connection once and notify every stream", async () => {
  const fixture = pair()
  const a = fixture.client.open("agent"), b = fixture.client.open("terminal")
  await Promise.all([a.ready, b.ready])
  const closed = vi.fn()
  for (const stream of fixture.accepted) stream.onClose = closed
  fixture.server.receive("bulk", new Uint8Array(MUX_FRAME_BYTES + 1))
  fixture.server.receive("control", new Uint8Array([0]))
  expect(fixture.serverFailure).toHaveBeenCalledOnce()
  expect(closed).toHaveBeenCalledTimes(2)
  expect(fixture.server.closed).toBe(true)
  expect(fixture.server.streamCount).toBe(0)
})

test("rejects reused stream IDs, excess credit, and data on a mismatched lane", async () => {
  const checks = [
    (fixture: ReturnType<typeof pair>, id: number) => fixture.server.receive("control", encodeMuxControl({ type: "open", id, purpose: "agent" })),
    (fixture: ReturnType<typeof pair>, id: number) => fixture.server.receive("control", encodeMuxControl({ type: "credit", id, bytes: 1 })),
    (fixture: ReturnType<typeof pair>, id: number) => fixture.server.receive("terminal", encodeMuxFrame({ id, sequence: 0, offset: 0, total: 0, text: false, data: new Uint8Array() })),
  ]
  for (const check of checks) {
    const fixture = pair()
    const stream = fixture.client.open("agent")
    await stream.ready
    check(fixture, stream.id)
    expect(fixture.serverFailure).toHaveBeenCalledOnce()
  }
})

test("bounds stream count and receive reassembly before allocating attacker-sized messages", async () => {
  const fixture = pair()
  const streams = Array.from({ length: MUX_MAX_STREAMS }, () => fixture.client.open("terminal"))
  expect(() => fixture.client.open("terminal")).toThrow("Too many")
  await Promise.all(streams.map(stream => stream.ready))
  const bytes = new Uint8Array(MUX_HEADER_BYTES + 1)
  new DataView(bytes.buffer).setUint32(0, streams[0]!.id)
  new DataView(bytes.buffer).setUint32(12, 0xffffffff)
  fixture.server.receive("terminal", bytes)
  expect(fixture.serverFailure).toHaveBeenCalledOnce()
})
