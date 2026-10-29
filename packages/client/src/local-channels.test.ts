import { expect, test, vi } from "vitest"
import { DataChannelErrorEvent } from "./data-channel.ts"
import { LocalDataChannel, LOCAL_CHANNEL_BUFFER_BYTES, LOCAL_CHANNEL_BUFFER_MESSAGES, LOCAL_CHANNEL_MESSAGE_BYTES, type LocalChannelEvent, type LocalChannelsApi } from "./local-channels.ts"

const settle = () => new Promise<void>(resolve => setImmediate(resolve))
function fixture() {
  const events = new Set<(event: LocalChannelEvent) => void>()
  const api: LocalChannelsApi = {
    open: vi.fn(async () => {}), send: vi.fn(async () => {}), close: vi.fn(async () => {}),
    onEvent: listener => { events.add(listener); return () => { events.delete(listener) } },
  }
  const channel = new LocalDataChannel(api, { connectionId: "local", teamId: "team", machineId: "machine", purpose: "agent" })
  return { api, channel, events, emit(event: LocalChannelEvent) { for (const listener of events) listener(event) } }
}

test("opens asynchronously and preserves frames arriving before authorization finishes", async () => {
  const f = fixture(), order: string[] = [], message = vi.fn()
  f.channel.onopen = () => order.push("open")
  f.channel.onmessage = event => { order.push("message"); message(event.data) }
  f.emit({ connectionId: "local", kind: "message", data: new Uint8Array([1, 2]) })
  expect(f.channel.readyState).toBe("connecting")
  expect(() => f.channel.send("early")).toThrow("not open")
  await settle()
  expect(order).toEqual(["open", "message"])
  expect(new Uint8Array(message.mock.calls[0]![0])).toEqual(new Uint8Array([1, 2]))
  f.channel.close()
  expect(f.events.size).toBe(0)
})

test("orders IPC sends, copies byte views, and accounts for UTF-8 backpressure until accepted", async () => {
  const f = fixture(), accepted = Promise.withResolvers<void>(), low = vi.fn()
  vi.mocked(f.api.send).mockReturnValueOnce(accepted.promise)
  await settle()
  f.channel.bufferedAmountLowThreshold = 2
  f.channel.addEventListener("bufferedamountlow", low)
  f.channel.send("你")
  const bytes = new Uint8Array([0, 1, 2, 0])
  f.channel.send(bytes.subarray(1, 3))
  bytes.fill(9)
  expect(f.channel.bufferedAmount).toBe(5)
  expect(f.api.send).toHaveBeenCalledExactlyOnceWith("local", "你")
  accepted.resolve(); await settle()
  expect(f.api.send).toHaveBeenNthCalledWith(2, "local", new Uint8Array([1, 2]))
  expect(f.channel.bufferedAmount).toBe(0)
  expect(low).toHaveBeenCalledOnce()
  f.channel.close()
})

test("bounds frames and queued bytes without silently dropping messages", async () => {
  const f = fixture(), accepted = Promise.withResolvers<void>()
  vi.mocked(f.api.send).mockReturnValueOnce(accepted.promise)
  await settle()
  expect(() => f.channel.send(new Uint8Array(LOCAL_CHANNEL_MESSAGE_BYTES + 1))).toThrow("64 KiB")
  for (let bytes = 0; bytes < LOCAL_CHANNEL_BUFFER_BYTES; bytes += LOCAL_CHANNEL_MESSAGE_BYTES) f.channel.send(new Uint8Array(LOCAL_CHANNEL_MESSAGE_BYTES))
  expect(f.channel.bufferedAmount).toBe(LOCAL_CHANNEL_BUFFER_BYTES)
  expect(() => f.channel.send("x")).toThrow("buffer is full")
  accepted.resolve(); await settle()
  expect(f.api.send).toHaveBeenCalledTimes(16)
  expect(f.channel.bufferedAmount).toBe(0)
  f.channel.close()
})

test("closing cancels queued sends and releases a late authorization completion", async () => {
  const f = fixture(), opened = Promise.withResolvers<void>(), close = vi.fn()
  vi.mocked(f.api.open).mockReturnValueOnce(opened.promise)
  f.channel.onclose = close
  await settle()
  f.channel.close()
  opened.resolve(); await settle()
  expect(f.channel.readyState).toBe("closed")
  expect(close).toHaveBeenCalledOnce()
  expect(f.api.close).toHaveBeenCalledTimes(2)
  expect(f.events.size).toBe(0)

  const sending = fixture(), accepted = Promise.withResolvers<void>()
  vi.mocked(sending.api.send).mockReturnValueOnce(accepted.promise)
  await settle()
  sending.channel.send("first"); sending.channel.send("cancelled")
  sending.channel.close(); accepted.resolve(); await settle()
  expect(sending.api.send).toHaveBeenCalledExactlyOnceWith("local", "first")
  expect(sending.channel.bufferedAmount).toBe(0)
})

test("empty messages cannot bypass the bounded send queue", async () => {
  const f = fixture(), accepted = Promise.withResolvers<void>()
  vi.mocked(f.api.send).mockReturnValueOnce(accepted.promise)
  await settle()
  f.channel.send("")
  for (let count = 0; count < LOCAL_CHANNEL_BUFFER_MESSAGES; count++) f.channel.send("")
  expect(() => f.channel.send("")).toThrow("buffer is full")
  f.channel.close(); accepted.resolve(); await settle()
  expect(f.api.send).toHaveBeenCalledOnce()
})

test.each(["open", "send"] as const)("surfaces %s errors and closes once without retrying a write", async operation => {
  const f = fixture(), errors = vi.fn(), closed = vi.fn()
  f.channel.onerror = errors; f.channel.onclose = closed
  vi.mocked(f.api[operation]).mockRejectedValueOnce(new Error("Access was revoked"))
  await settle()
  if (operation === "send") { f.channel.send("request"); f.channel.send("queued"); await settle() }
  expect(errors.mock.calls[0]![0]).toBeInstanceOf(DataChannelErrorEvent)
  expect(errors.mock.calls[0]![0].error.message).toBe("Access was revoked")
  expect(closed).toHaveBeenCalledOnce()
  expect(f.channel.readyState).toBe("closed")
  expect(f.events.size).toBe(0)
  expect(f.api.send).toHaveBeenCalledTimes(operation === "send" ? 1 : 0)
})

test("remote closure affects only its connection and binaryType controls received binary data", async () => {
  const f = fixture(), messages = vi.fn(), close = vi.fn()
  f.channel.onmessage = messages; f.channel.onclose = close
  await settle()
  f.channel.binaryType = "blob"
  f.emit({ connectionId: "local", kind: "message", data: new Uint8Array([1]) })
  expect(messages.mock.calls[0]![0].data).toBeInstanceOf(Blob)
  f.emit({ connectionId: "other", kind: "closed" })
  expect(f.channel.readyState).toBe("open")
  f.emit({ connectionId: "local", kind: "closed" })
  expect(close).toHaveBeenCalledOnce()
  expect(f.events.size).toBe(0)
})
