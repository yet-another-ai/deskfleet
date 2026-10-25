import { expect, test, vi } from "vitest"
import { FILE_CHUNK_BYTES, FILE_PIPELINE_BYTES, type FileEndpoint, type FileMethods } from "../../../apps/daemon/src/files-protocol.ts"
import { copyFileChunks, FILE_PIPELINE_CHUNKS } from "./file-pipeline.ts"

const file = { name: "payload.bin", path: "/payload.bin", kind: "file", size: FILE_CHUNK_BYTES * FILE_PIPELINE_CHUNKS * 2 + 7, modifiedAt: 1 } as const
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test("overlaps bounded reads and writes, preserves offsets despite reordered reads, and counts only acknowledgements", async () => {
  const firstRead = gate(), acknowledgements = gate()
  const bytes = Buffer.alloc(FILE_CHUNK_BYTES).map((_, index) => index % 251)
  const reads: number[] = [], writes: number[] = []
  let progress = 0, finished = false
  const source = {
    async call(_method: string, { offset, length }: FileMethods["read"]["params"]) {
      reads.push(offset)
      if (offset === 0) await firstRead.promise
      return { value: { bytes: length }, data: bytes.subarray(0, length) }
    },
  } as unknown as FileEndpoint
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
  expect(reads.length * FILE_CHUNK_BYTES).toBe(64 * 1024 * 1024)
  expect(progress).toBe(0)
  expect(finished).toBe(false)
  acknowledgements.resolve()
  await copying
  expect(writes).toEqual(Array.from({ length: Math.ceil(file.size / FILE_CHUNK_BYTES) }, (_, index) => index * FILE_CHUNK_BYTES))
  expect(progress).toBe(file.size)
})

test("a failed read ahead is observed and drained before the file rejects", async () => {
  const firstRead = gate()
  const bytes = new Uint8Array(FILE_CHUNK_BYTES)
  const write = vi.fn()
  let readCount = 0
  const source = {
    async call(_method: string, { offset, length }: FileMethods["read"]["params"]) {
      ++readCount
      if (offset === 0) await firstRead.promise
      if (offset === FILE_CHUNK_BYTES) throw new Error("Source changed")
      return { value: { bytes: length }, data: bytes.subarray(0, length) }
    },
  } as unknown as FileEndpoint
  const copying = copyFileChunks({ source, destination: { call: write } as unknown as FileEndpoint, file, transferId: "copy", path: "", check() {}, progress() {} })
  const failed = expect(copying).rejects.toThrow("Source changed")
  await vi.waitFor(() => expect(readCount).toBe(FILE_PIPELINE_CHUNKS))
  expect(write).not.toHaveBeenCalled()
  firstRead.resolve()
  await failed
  expect(write).not.toHaveBeenCalled()
  expect(readCount).toBe(FILE_PIPELINE_CHUNKS)
})

test("cancellation drains issued writes without starting another window or advancing progress", async () => {
  const acknowledgements = gate()
  const bytes = new Uint8Array(FILE_CHUNK_BYTES)
  let cancelled = false, writes = 0, finished = false, progress = 0
  const source = { async call(_method: string, { length }: FileMethods["read"]["params"]) { return { value: { bytes: length }, data: bytes.subarray(0, length) } } } as unknown as FileEndpoint
  const destination = {
    async call(_method: string, _params: unknown, data: Uint8Array) { ++writes; await acknowledgements.promise; return { value: { bytes: data.length } } },
  } as unknown as FileEndpoint
  const copying = copyFileChunks({ source, destination, file, transferId: "copy", path: "", check() { if (cancelled) throw new Error("Cancelled") }, progress: bytes => { progress += bytes } }).finally(() => { finished = true })
  const failed = expect(copying).rejects.toThrow("Cancelled")
  await vi.waitFor(() => expect(writes).toBe(FILE_PIPELINE_CHUNKS))
  expect(writes * FILE_CHUNK_BYTES).toBe(FILE_PIPELINE_BYTES)
  cancelled = true
  expect(finished).toBe(false)
  acknowledgements.resolve()
  await failed
  expect(writes).toBe(FILE_PIPELINE_CHUNKS)
  expect(progress).toBe(0)
})
