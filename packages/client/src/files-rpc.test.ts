import { expect, test, vi } from "vitest"
import { FilesRpcClient } from "./files-rpc.ts"
import { encodeFileFrame, FileFrameDecoder, FILE_WIRE_CHUNK_BYTES } from "../../../apps/daemon/src/files-wire.ts"
import { FILE_CHUNK_BYTES, FILE_MAX_PENDING_REQUESTS, FILE_PIPELINE_CHUNKS } from "../../../apps/daemon/src/files-protocol.ts"

test("file RPC multiplexes binary replies and preserves actionable conflict errors", async () => {
  const client = new FilesRpcClient(async receive => {
    const decoder = new FileFrameDecoder()
    return {
      async send(bytes) {
        for (const frame of decoder.push(bytes)) {
          const result = frame.header.method === "begin"
            ? encodeFileFrame({ id: frame.header.id, error: { code: "conflict", message: "Already exists" } })
            : encodeFileFrame({ id: frame.header.id, value: { bytes: frame.data.length } }, frame.data)
          // A single network message may contain less than the length prefix.
          receive(result.subarray(0, 2)); receive(result.subarray(2))
        }
      }, async close() {},
    }
  })
  const value = await client.call("write", { transferId: "a", path: "", offset: 0 }, new Uint8Array([0, 255, 3]))
  expect([...value.data!]).toEqual([0, 255, 3])
  await expect(client.call("begin", { directory: "/", name: "a", kind: "file", conflict: "ask" })).rejects.toMatchObject({ code: "conflict" })
  await client.close()
})

test("an interrupted write rejects without replay and the next request reconnects", async () => {
  let attempts = 0, writes = 0
  const closes = vi.fn(async () => {})
  const client = new FilesRpcClient(async (receive, fail) => {
    const attempt = ++attempts
    const decoder = new FileFrameDecoder()
    return { close: closes, async send(bytes) {
      for (const frame of decoder.push(bytes)) {
        if (frame.header.method === "write") writes++
        if (attempt === 1) fail(new Error("Disconnected"))
        else receive(encodeFileFrame({ id: frame.header.id, value: { bytes: 1 } }))
      }
    } }
  })
  await expect(client.call("write", { transferId: "a", path: "", offset: 0 }, new Uint8Array([1]))).rejects.toThrow("Disconnected")
  expect(writes).toBe(1)
  await expect(client.call("read", { path: "/a", offset: 0, length: 1 })).resolves.toMatchObject({ value: { bytes: 1 } })
  expect(attempts).toBe(2)
  await client.close()
  expect(closes).toHaveBeenCalled()
})

test("a maximum-sized write uses two transport messages without a tiny final fragment", async () => {
  const packets: Uint8Array[] = [], decoder = new FileFrameDecoder()
  const payload = new Uint8Array(FILE_CHUNK_BYTES).map((_, index) => index % 251)
  const client = new FilesRpcClient(async receive => ({
    async send(bytes) {
      packets.push(bytes)
      for (const frame of decoder.push(bytes)) {
        expect(frame.data).toEqual(payload)
        receive(encodeFileFrame({ id: frame.header.id, value: { bytes: frame.data.length } }))
      }
    }, async close() {},
  }))
  try {
    await expect(client.call("write", { transferId: "upload", path: "", offset: 0 }, payload)).resolves.toMatchObject({ value: { bytes: payload.length } })
    expect(packets).toHaveLength(2)
    expect(packets[0]!.length).toBe(FILE_WIRE_CHUNK_BYTES)
    expect(packets[1]!.length).toBeGreaterThan(63 * 1024)
    expect(packets[1]!.length).toBeLessThanOrEqual(FILE_WIRE_CHUNK_BYTES)
  } finally { await client.close() }
})

test("a blocked transport accepts a complete 64 MiB window and leaves room for control requests", async () => {
  let release!: () => void
  const sending = new Promise<void>(resolve => { release = resolve })
  let submitted = 0
  const client = new FilesRpcClient(async receive => {
    const decoder = new FileFrameDecoder()
    return { async close() {}, async send(bytes) {
      await sending
      for (const frame of decoder.push(bytes)) {
        submitted++
        receive(encodeFileFrame({ id: frame.header.id, value: { bytes: frame.data.length } }))
      }
    } }
  })
  const data = new Uint8Array(FILE_CHUNK_BYTES)
  const writes = Array.from({ length: FILE_PIPELINE_CHUNKS }, (_, index) => client.call("write", { transferId: "copy", path: "", offset: index * data.length }, data))
  try {
    await expect(client.call("write", { transferId: "copy", path: "", offset: FILE_PIPELINE_CHUNKS * data.length }, data)).rejects.toThrow("window is full")
    const controls = Array.from({ length: FILE_MAX_PENDING_REQUESTS - FILE_PIPELINE_CHUNKS }, () => client.call("stat", { path: "/payload" }))
    await expect(client.call("stat", { path: "/overflow" })).rejects.toThrow("Too many pending")
    expect(submitted).toBe(0)
    release()
    const responses = await Promise.all(writes)
    await Promise.all(controls)
    expect(responses.every(reply => reply.value.bytes === FILE_CHUNK_BYTES)).toBe(true)
    expect(submitted).toBe(FILE_MAX_PENDING_REQUESTS)
    await expect(client.call("write", { transferId: "copy", path: "", offset: 0 }, data)).resolves.toMatchObject({ value: { bytes: FILE_CHUNK_BYTES } })
  } finally { release(); await client.close() }
})

test("queued requests tolerate ongoing partial replies beyond a minute but a stalled peer times out", async () => {
  vi.useFakeTimers()
  let receive!: (bytes: Uint8Array) => void
  const closed = vi.fn(async () => {})
  const client = new FilesRpcClient(async onReceive => {
    receive = onReceive
    return { close: closed, async send() {} }
  })
  try {
    const first = client.call("read", { path: "/payload", offset: 0, length: 1 })
    const last = client.call("read", { path: "/payload", offset: 1, length: 1 })
    const replies = Promise.all([first, last])
    await vi.advanceTimersByTimeAsync(45_000)
    const response = encodeFileFrame({ id: 1, value: { bytes: 1 } }, new Uint8Array([1]))
    receive(response.subarray(0, 2))
    await vi.advanceTimersByTimeAsync(45_000)
    receive(response.subarray(2))
    await vi.advanceTimersByTimeAsync(45_000)
    receive(encodeFileFrame({ id: 2, value: { bytes: 1 } }, new Uint8Array([2])))
    expect((await replies).map(reply => reply.data![0])).toEqual([1, 2])
    expect(closed).not.toHaveBeenCalled()

    const stalled = expect(client.call("stat", { path: "/payload" })).rejects.toThrow("timed out")
    await vi.advanceTimersByTimeAsync(60_000)
    await stalled
    expect(closed).toHaveBeenCalledOnce()
  } finally { await client.close(); vi.useRealTimers() }
})
