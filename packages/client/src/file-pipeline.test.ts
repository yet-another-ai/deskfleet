import { expect, test, vi } from "vitest"
import { FILE_CHUNK_BYTES, FILE_PIPELINE_BYTES, type FileEndpoint, type FileMethods } from "../../../apps/daemon/src/files-protocol.ts"
import { copyFileChunks, FILE_PIPELINE_CHUNKS } from "./file-pipeline.ts"

const file = { name: "payload.bin", path: "/payload.bin", kind: "file", size: FILE_CHUNK_BYTES * FILE_PIPELINE_CHUNKS * 2 + 7, modifiedAt: 1 } as const
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function readingEndpoint(read: (params: FileMethods["read"]["params"]) => Promise<unknown>) {
  const close = vi.fn(async () => ({ value: null }))
  const endpoint = {
    async call(method: string, params: unknown) {
      if (method === "openRead") return { value: { readId: "source-read" } }
      if (method === "closeRead") return close()
      expect(method).toBe("read")
      expect(params).toMatchObject({ readId: "source-read" })
      return read(params as FileMethods["read"]["params"])
    },
  } as unknown as FileEndpoint
  return { endpoint, close }
}

test("overlaps bounded reads and writes, preserves offsets despite reordered reads, and counts only acknowledgements", async () => {
  const firstRead = gate(), acknowledgements = gate()
  const bytes = Buffer.alloc(FILE_CHUNK_BYTES).map((_, index) => index % 251)
  const reads: number[] = [], writes: number[] = []
  let progress = 0, finished = false
  const { endpoint: source, close } = readingEndpoint(async ({ offset, length }) => {
      reads.push(offset)
      if (offset === 0) await firstRead.promise
      return { value: { bytes: length }, data: bytes.subarray(0, length) }
  })
  const destination = {
    async call(_method: string, { offset }: FileMethods["write"]["params"], data: Uint8Array) {
      writes.push(offset)
      expect(Buffer.from(data.buffer, data.byteOffset, data.byteLength).equals(bytes.subarray(0, data.length))).toBe(true)
      await acknowledgements.promise
      return { value: { bytes: data.length } }
    },
  } as unknown as FileEndpoint
  const copying = copyFileChunks({ source, destination, file, transferId: "copy", path: "", check() {}, progress: bytes => { progress += bytes } }).then(() => { finished = true })
  await vi.waitFor(() => expect(reads).toHaveLength(FILE_PIPELINE_CHUNKS))
  expect(writes).toEqual([])
  firstRead.resolve()
  await vi.waitFor(() => expect(writes).toHaveLength(FILE_PIPELINE_CHUNKS))
  expect(reads).toHaveLength(FILE_PIPELINE_CHUNKS)
  // A blocked receiver must not expand the content budget when chunks grow.
  expect(reads.length * FILE_CHUNK_BYTES).toBeLessThanOrEqual(FILE_PIPELINE_BYTES)
  expect((reads.length + 1) * FILE_CHUNK_BYTES).toBeGreaterThan(FILE_PIPELINE_BYTES)
  expect(progress).toBe(0)
  expect(finished).toBe(false)
  expect(close).not.toHaveBeenCalled()
  acknowledgements.resolve()
  await copying
  expect(writes).toEqual(Array.from({ length: Math.ceil(file.size / FILE_CHUNK_BYTES) }, (_, index) => index * FILE_CHUNK_BYTES))
  expect(progress).toBe(file.size)
  expect(close).toHaveBeenCalledOnce()
})

test("a failed read ahead is observed and drained before the file rejects", async () => {
  const firstRead = gate()
  const bytes = new Uint8Array(FILE_CHUNK_BYTES)
  const write = vi.fn()
  let readCount = 0
  const { endpoint: source, close } = readingEndpoint(async ({ offset, length }) => {
      ++readCount
      if (offset === 0) await firstRead.promise
      if (offset === FILE_CHUNK_BYTES) throw new Error("Source changed")
      return { value: { bytes: length }, data: bytes.subarray(0, length) }
  })
  const copying = copyFileChunks({ source, destination: { call: write } as unknown as FileEndpoint, file, transferId: "copy", path: "", check() {}, progress() {} })
  const failed = expect(copying).rejects.toThrow("Source changed")
  await vi.waitFor(() => expect(readCount).toBe(FILE_PIPELINE_CHUNKS))
  expect(write).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
  firstRead.resolve()
  await failed
  expect(write).not.toHaveBeenCalled()
  expect(readCount).toBe(FILE_PIPELINE_CHUNKS)
  expect(close).toHaveBeenCalledOnce()
})

test("cancellation drains issued writes without starting another window or advancing progress", async () => {
  const acknowledgements = gate()
  const bytes = new Uint8Array(FILE_CHUNK_BYTES)
  let cancelled = false, writes = 0, finished = false, progress = 0
  const { endpoint: source, close } = readingEndpoint(async ({ length }) => ({ value: { bytes: length }, data: bytes.subarray(0, length) }))
  const destination = {
    async call(_method: string, _params: unknown, data: Uint8Array) { ++writes; await acknowledgements.promise; return { value: { bytes: data.length } } },
  } as unknown as FileEndpoint
  const copying = copyFileChunks({ source, destination, file, transferId: "copy", path: "", check() { if (cancelled) throw new Error("Cancelled") }, progress: bytes => { progress += bytes } }).finally(() => { finished = true })
  const failed = expect(copying).rejects.toThrow("Cancelled")
  await vi.waitFor(() => expect(writes).toBe(FILE_PIPELINE_CHUNKS))
  expect(writes * FILE_CHUNK_BYTES).toBeLessThanOrEqual(FILE_PIPELINE_BYTES)
  expect((writes + 1) * FILE_CHUNK_BYTES).toBeGreaterThan(FILE_PIPELINE_BYTES)
  cancelled = true
  expect(finished).toBe(false)
  expect(close).not.toHaveBeenCalled()
  acknowledgements.resolve()
  await failed
  expect(writes).toBe(FILE_PIPELINE_CHUNKS)
  expect(progress).toBe(0)
  expect(close).toHaveBeenCalledOnce()
})

test.each(["read", "write", "cancel"] as const)("preserves the %s failure when source cleanup also rejects", async stage => {
  const original = new Error(`${stage} failed`)
  const { endpoint: source, close } = readingEndpoint(async ({ length }) => {
    if (stage === "read") throw original
    return { value: { bytes: length }, data: new Uint8Array(length) }
  })
  close.mockRejectedValue(new Error("closeRead failed"))
  const destination = {
    async call(_method: string, _params: unknown, data: Uint8Array) {
      if (stage === "write") throw original
      return { value: { bytes: data.length } }
    },
  } as unknown as FileEndpoint
  let checks = 0
  await expect(copyFileChunks({
    source, destination, file: { ...file, size: 1 }, transferId: "copy", path: "",
    check() { if (++checks === 2 && stage === "cancel") throw original }, progress() {},
  })).rejects.toBe(original)
  expect(close).toHaveBeenCalledOnce()
})

test("final source validation failure rejects a fully acknowledged copy", async () => {
  const { endpoint: source, close } = readingEndpoint(async ({ length }) => ({ value: { bytes: length }, data: new Uint8Array(length) }))
  close.mockRejectedValue(new Error("Source changed before close"))
  const destination = { async call(_method: string, _params: unknown, data: Uint8Array) { return { value: { bytes: data.length } } } } as unknown as FileEndpoint
  await expect(copyFileChunks({ source, destination, file: { ...file, size: 1 }, transferId: "copy", path: "", check() {}, progress() {} })).rejects.toThrow("Source changed before close")
  expect(close).toHaveBeenCalledOnce()
})
