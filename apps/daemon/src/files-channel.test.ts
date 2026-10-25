import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { FilesChannel, fileAction } from "./files-channel.ts"
import { FilesService } from "./files-service.ts"
import { FileFrameDecoder, encodeFileFrame, FILE_WIRE_CHUNK_BYTES, type FileFrame, type FileFrameHeader } from "./files-wire.ts"
import { FILE_CHUNK_BYTES, FILE_MAX_PENDING_REQUESTS, FILE_PIPELINE_BYTES, FILE_PIPELINE_CHUNKS, FILE_RPC_METADATA_BYTES, type FileEndpoint } from "./files-protocol.ts"

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await delay(1)
  assert.equal(predicate(), true)
}

function receive(channel: FilesChannel, header: FileFrameHeader, data?: Uint8Array): void {
  const frame = encodeFileFrame(header, data)
  for (let offset = 0; offset < frame.length; offset += FILE_WIRE_CHUNK_BYTES) channel.receive(frame.subarray(offset, offset + FILE_WIRE_CHUNK_BYTES))
}

test("file channel transfers binary data and cleans incomplete uploads on close", async context => {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-file-channel-"))
  const decoder = new FileFrameDecoder(), replies: FileFrame[] = [], failures: unknown[] = []
  const actions: string[] = []
  let backpressure = true
  const channel = new FilesChannel(new FilesService(), async data => {
    assert(data.byteLength <= FILE_WIRE_CHUNK_BYTES)
    if (backpressure) { backpressure = false; throw new Error("send buffer is full") }
    replies.push(...decoder.push(data))
  }, method => { actions.push(fileAction(method)) }, error => failures.push(error))
  context.after(async () => { await channel.close(); await rm(directory, { recursive: true, force: true }) })
  let nextId = 0
  const request = async (method: FileFrameHeader["method"], params: unknown, data?: Uint8Array) => {
    const id = ++nextId
    const frame = encodeFileFrame({ id, method, params }, data)
    for (let offset = 0; offset < frame.length; offset += FILE_WIRE_CHUNK_BYTES) channel.receive(frame.subarray(offset, offset + FILE_WIRE_CHUNK_BYTES), false)
    await until(() => replies.some(reply => reply.header.id === id) || failures.length > 0)
    assert.deepEqual(failures, [])
    return replies.find(reply => reply.header.id === id)!
  }
  const begin = await request("begin", { directory, name: "bytes", kind: "file", conflict: "ask" })
  const { transferId } = begin.header.value as { transferId: string }
  const bytes = Buffer.alloc(FILE_CHUNK_BYTES, 255)
  await request("write", { transferId, path: "", offset: 0 }, bytes)
  await request("finish", { transferId, path: "", size: bytes.length })
  await request("commit", { transferId })
  assert.deepEqual(await readFile(join(directory, "bytes")), bytes)
  const read = await request("read", { path: join(directory, "bytes"), offset: 0, length: bytes.length })
  assert.deepEqual(Buffer.from(read.data), bytes)
  await request("begin", { directory, name: "unfinished", kind: "file", conflict: "ask" })
  await channel.close()
  assert.deepEqual(await readdir(directory), ["bytes"])
  assert(actions.includes("files:read") && actions.includes("files:write"))
})

test("revoking read permission during I/O prevents the response from leaving the peer", async () => {
  let finishRead!: () => void
  let allowed = true, closed = false
  const sent: Uint8Array[] = [], failures: unknown[] = []
  const pending = new Promise<{ value: { bytes: number }; data: Uint8Array }>(ready => {
    finishRead = () => ready({ value: { bytes: 6 }, data: Buffer.from("secret") })
  })
  const endpoint = { call: () => pending, close: async () => { closed = true } } as FileEndpoint
  const channel = new FilesChannel(endpoint, async data => { sent.push(data) }, () => { if (!allowed) throw new Error("grant expired") }, error => failures.push(error))
  channel.receive(encodeFileFrame({ id: 1, method: "read", params: {} }), false)
  allowed = false
  finishRead()
  await until(() => closed)
  assert.deepEqual(sent, [])
  assert.match(String(failures[0]), /grant expired/)
})

test("write requests require their own permission before reaching the endpoint", async () => {
  let called = false, closed = false
  const failures: unknown[] = []
  const endpoint = { call: async () => { called = true; return { value: null } }, close: async () => { closed = true } } as FileEndpoint
  const channel = new FilesChannel(endpoint, async () => {}, method => {
    if (fileAction(method) === "files:write") throw new Error("read-only grant")
  }, error => failures.push(error))
  channel.receive(encodeFileFrame({ id: 1, method: "begin", params: {} }), false)
  await until(() => closed)
  assert.equal(called, false)
  assert.match(String(failures[0]), /read-only grant/)
})

test("a complete 64 MiB read window and a control request can await a slow sender", async context => {
  const payload = Buffer.alloc(FILE_CHUNK_BYTES, 137)
  let release!: () => void, sending!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { sending = resolve })
  const decoder = new FileFrameDecoder(), failures: unknown[] = []
  let reads = 0, replies = 0, receivedBytes = 0
  const endpoint = {
    async call(method: string) {
      if (method === "read") { reads++; return { value: { bytes: payload.length }, data: payload } }
      return { value: { path: "/control" } }
    }, async close() {},
  } as FileEndpoint
  const channel = new FilesChannel(endpoint, async data => {
    sending(); await blocked
    for (const frame of decoder.push(data)) {
      replies++
      if (frame.header.id <= FILE_PIPELINE_CHUNKS) {
        assert(payload.equals(frame.data))
        receivedBytes += frame.data.byteLength
      } else assert.deepEqual(frame.header.value, { path: "/control" })
    }
  }, () => {}, error => failures.push(error))
  context.after(async () => { release(); await channel.close() })
  for (let id = 1; id <= FILE_PIPELINE_CHUNKS; id++) receive(channel, { id, method: "read", params: { path: "/file", offset: (id - 1) * FILE_CHUNK_BYTES, length: FILE_CHUNK_BYTES } })
  receive(channel, { id: FILE_PIPELINE_CHUNKS + 1, method: "stat", params: { path: "/control" } })
  await started
  assert.equal(reads, FILE_PIPELINE_CHUNKS)
  assert.deepEqual(failures, [])
  release()
  await until(() => replies === FILE_PIPELINE_CHUNKS + 1 || failures.length > 0)
  assert.deepEqual(failures, [])
  assert.equal(receivedBytes, FILE_PIPELINE_BYTES)
})

test("pending write payload is capped at 64 MiB independently of request count", async () => {
  let release!: () => void, writes = 0, closed = false
  const held = new Promise<{ value: { bytes: number } }>(resolve => { release = () => resolve({ value: { bytes: FILE_CHUNK_BYTES } }) })
  const failures: unknown[] = []
  const endpoint = { call: () => { writes++; return held }, close: async () => { closed = true; release() } } as FileEndpoint
  const channel = new FilesChannel(endpoint, async () => {}, () => {}, error => failures.push(error))
  try {
    const payload = Buffer.alloc(FILE_CHUNK_BYTES)
    for (let id = 1; id <= FILE_PIPELINE_CHUNKS; id++) receive(channel, { id, method: "write", params: { transferId: "upload", path: "", offset: (id - 1) * FILE_CHUNK_BYTES } }, payload)
    assert.equal(writes, FILE_PIPELINE_CHUNKS)
    assert.deepEqual(failures, [])
    receive(channel, { id: FILE_PIPELINE_CHUNKS + 1, method: "write", params: { transferId: "upload", path: "", offset: FILE_PIPELINE_BYTES } }, new Uint8Array(1))
    await until(() => closed)
    assert.equal(writes, FILE_PIPELINE_CHUNKS)
    assert.match(String(failures[0]), /payload queue is full/)
  } finally { await channel.close() }
})

test("the larger request window retains the 8 MiB aggregate metadata budget", async () => {
  let release!: () => void, calls = 0, closed = false
  const held = new Promise<{ value: null }>(resolve => { release = () => resolve({ value: null }) })
  const failures: unknown[] = []
  const endpoint = { call: () => { calls++; return held }, close: async () => { closed = true; release() } } as FileEndpoint
  const channel = new FilesChannel(endpoint, async () => {}, () => {}, error => failures.push(error))
  try {
    const path = "/" + "a".repeat(FILE_RPC_METADATA_BYTES / 2)
    receive(channel, { id: 1, method: "stat", params: { path } })
    assert.equal(calls, 1)
    receive(channel, { id: 2, method: "stat", params: { path } })
    await until(() => closed)
    assert.equal(calls, 1)
    assert.match(String(failures[0]), /metadata queue is full/)
  } finally { await channel.close() }
})

test("pending request count and duplicate IDs remain bounded", async () => {
  for (const duplicate of [false, true]) {
    let release!: () => void, calls = 0, closed = false
    const held = new Promise<{ value: null }>(resolve => { release = () => resolve({ value: null }) })
    const failures: unknown[] = []
    const endpoint = { call: () => { calls++; return held }, close: async () => { closed = true; release() } } as FileEndpoint
    const channel = new FilesChannel(endpoint, async () => {}, () => {}, error => failures.push(error))
    try {
      const limit = duplicate ? 1 : FILE_MAX_PENDING_REQUESTS
      for (let id = 1; id <= limit; id++) receive(channel, { id, method: "stat", params: { path: "/file" } })
      assert.deepEqual(failures, [])
      receive(channel, { id: duplicate ? 1 : limit + 1, method: "stat", params: { path: "/file" } })
      await until(() => closed)
      assert.equal(calls, limit)
      assert.match(String(failures[0]), /pending file requests or duplicate/)
    } finally { await channel.close() }
  }
})
