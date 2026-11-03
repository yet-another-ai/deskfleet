import { afterEach, expect, test, vi } from "vitest"
import type { MuxStream } from "@deskfleet/client/mux/connection"
import { LOCAL_CHANNEL_BUFFER_BYTES, LOCAL_CHANNEL_MESSAGE_BYTES, type LocalChannelOpen } from "@deskfleet/client/local-channels"
import { WindowMuxChannels } from "./mux-channels-controller.ts"
import { RelayConnectionError } from "@deskfleet/client/relay"

const request: LocalChannelOpen = { connectionId: "view", teamId: "team", machineId: "machine", purpose: "terminal" }
function stream() {
  return {
    state: "open", onData: undefined as MuxStream["onData"], onClose: undefined as MuxStream["onClose"],
    send: vi.fn(async (_value: string | Uint8Array) => {}), close: vi.fn(),
  }
}
function fixture(value = stream()) {
  const open = vi.fn(async () => value as unknown as MuxStream), emit = vi.fn()
  return { stream: value, open, emit, channels: new WindowMuxChannels(open, emit) }
}
afterEach(() => { vi.useRealTimers() })

test("serializes relay recovery metadata when the shared peer cannot connect", async () => {
  const f = fixture()
  f.open.mockRejectedValue(new RelayConnectionError("free_plan"))
  await expect(f.channels.open(request)).rejects.toBeInstanceOf(RelayConnectionError)
  expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "closed", relayDeniedReason: "free_plan" }))
})

test("renderer delivery ACK releases the logical stream receive window only after delivery", async () => {
  const f = fixture()
  await f.channels.open(request)
  let consumed = false
  const receiving = Promise.resolve(f.stream.onData!("output")).then(() => { consumed = true })
  await Promise.resolve()
  expect(consumed).toBe(false)
  expect(f.emit).toHaveBeenCalledExactlyOnceWith({ connectionId: "view", kind: "message", sequence: 1, data: "output" })
  await f.channels.acknowledge("view", 99)
  expect(consumed).toBe(false)
  await f.channels.acknowledge("view", 1)
  await receiving
  expect(consumed).toBe(true)
  await f.channels.dispose()
})

test("closing a renderer releases only its own streams and settles delivery waits", async () => {
  const a = fixture(), b = fixture()
  await Promise.all([a.channels.open(request), b.channels.open(request)])
  const receiving = a.stream.onData!("output")
  await a.channels.dispose()
  await receiving
  expect(a.stream.close).toHaveBeenCalledOnce()
  expect(b.stream.close).not.toHaveBeenCalled()
  await b.channels.send("view", "still connected")
  expect(b.stream.send).toHaveBeenCalledExactlyOnceWith("still connected")
  expect(() => a.channels.send("view", "stale")).toThrow("not open in this window")
  await b.channels.dispose()
})

test("a document retired during pooled connection setup closes the late stream", async () => {
  const f = fixture()
  let resolve!: (value: MuxStream) => void
  f.open.mockImplementation(() => new Promise(done => { resolve = done }))
  const opening = f.channels.open(request)
  const rejected = expect(opening).rejects.toThrow("cancelled")
  await f.channels.dispose()
  resolve(f.stream as unknown as MuxStream)
  await rejected
  expect(f.stream.close).toHaveBeenCalledOnce()
})

test("unsupported peers keep a distinct fallback error and never create renderer authority", async () => {
  const f = fixture()
  f.open.mockResolvedValueOnce(undefined as unknown as MuxStream)
  await expect(f.channels.open(request)).rejects.toThrow("Mux transport is unsupported")
  expect(() => f.channels.send("view", "data")).toThrow("not open in this window")
  expect(f.stream.send).not.toHaveBeenCalled()
  expect(f.stream.close).not.toHaveBeenCalled()
})

test("renderer uploads retain ordering, snapshot bytes, and enforce the pending byte limit", async () => {
  const f = fixture()
  await f.channels.open(request)
  let release!: () => void
  f.stream.send.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const input = new Uint8Array(LOCAL_CHANNEL_MESSAGE_BYTES).fill(1)
  const sending = f.channels.send("view", input)
  input.fill(2)
  await Promise.resolve()
  const queued = Array.from({ length: LOCAL_CHANNEL_BUFFER_BYTES / LOCAL_CHANNEL_MESSAGE_BYTES - 1 }, () => f.channels.send("view", input))
  expect(() => f.channels.send("view", "overflow")).toThrow("send buffer is full")
  expect((f.stream.send.mock.calls[0]![0] as Uint8Array)[0]).toBe(1)
  expect(f.stream.send).toHaveBeenCalledOnce()
  release()
  await Promise.all([sending, ...queued])
  await f.channels.dispose()
})

test("a stalled renderer closes its logical stream and resolves outstanding delivery credits", async () => {
  vi.useFakeTimers()
  const f = fixture()
  await f.channels.open(request)
  const receiving = f.stream.onData!("output")
  await vi.advanceTimersByTimeAsync(5_000)
  await receiving
  expect(f.stream.close).toHaveBeenCalledOnce()
  expect(f.emit).toHaveBeenLastCalledWith({ connectionId: "view", kind: "closed", error: "Mux renderer delivery timed out" })
})

test("another window cannot acknowledge or send on a logical stream it does not own", async () => {
  const a = fixture(), b = fixture()
  await a.channels.open(request)
  expect(() => b.channels.send("view", "data")).toThrow("not open in this window")
  await expect(b.channels.acknowledge("view", 1)).rejects.toThrow("not open in this window")
  await a.channels.dispose()
})

test("incoming IPC data stays bounded even if a stream consumer is called concurrently", async () => {
  const f = fixture()
  await f.channels.open(request)
  const receive = f.stream.onData!
  const incoming = Array.from({ length: LOCAL_CHANNEL_BUFFER_BYTES / LOCAL_CHANNEL_MESSAGE_BYTES + 1 }, () => receive(new Uint8Array(LOCAL_CHANNEL_MESSAGE_BYTES)))
  await Promise.all(incoming)
  expect(f.stream.close).toHaveBeenCalledOnce()
  expect(f.emit).toHaveBeenLastCalledWith({ connectionId: "view", kind: "closed", error: "Mux channel receive buffer is full" })
})
