import assert from "node:assert/strict"
import test from "node:test"
import { FILE_CHUNK_BYTES } from "./files-protocol.ts"
import { encodeFileFrame, FileFrameDecoder, FILE_WIRE_CHUNK_BYTES } from "./files-wire.ts"

test("file frames preserve binary bytes across fragmented prefixes and coalesced messages", () => {
  const bytes = new Uint8Array([0, 255, 0, 1, 128])
  const first = encodeFileFrame({ id: 1, method: "write", params: { path: "图片.png" } }, bytes)
  const second = encodeFileFrame({ id: 2, value: { bytes: 5 } })
  const joined = Buffer.concat([first, second])
  const decoder = new FileFrameDecoder()
  const frames = []
  for (let i = 0; i < joined.length; i += 3) frames.push(...decoder.push(joined.subarray(i, i + 3)))
  assert.equal(frames.length, 2)
  assert.equal(frames[0].header.id, 1)
  assert.deepEqual(frames[0].data, bytes)
  assert.equal(frames[0].metadataBytes, first.length - bytes.length)
  assert.deepEqual(frames[1].header.value, { bytes: 5 })
  assert.equal(frames[1].metadataBytes, second.length)
})

test("maximum-sized ordinary reads and writes use two DataChannel messages", () => {
  const bytes = new Uint8Array(FILE_CHUNK_BYTES).map((_, index) => index % 251)
  for (const header of [
    { id: 1, method: "write" as const, params: { transferId: "upload", path: "图片.png", offset: 1024 * 1024 } },
    { id: 2, value: { bytes: bytes.length } },
  ]) {
    const frame = encodeFileFrame(header, bytes)
    assert.equal(Math.ceil(frame.length / FILE_WIRE_CHUNK_BYTES), 2)
    const decoder = new FileFrameDecoder()
    assert.deepEqual(decoder.push(frame.subarray(0, FILE_WIRE_CHUNK_BYTES)), [])
    const decoded = decoder.push(frame.subarray(FILE_WIRE_CHUNK_BYTES))
    assert.equal(decoded.length, 1)
    assert.deepEqual(decoded[0].header, header)
    assert.deepEqual(decoded[0].data, bytes)
  }
})

test("metadata larger than the usual headroom still fragments and preserves binary data", () => {
  const bytes = new Uint8Array(FILE_CHUNK_BYTES).fill(231)
  const header = { id: 1, method: "write" as const, params: { transferId: "upload", path: "图片/".repeat(500), offset: 0 } }
  const frame = encodeFileFrame(header, bytes)
  assert(frame.length > 2 * FILE_WIRE_CHUNK_BYTES)
  const decoder = new FileFrameDecoder(), decoded = []
  for (let offset = 0; offset < frame.length; offset += FILE_WIRE_CHUNK_BYTES) decoded.push(...decoder.push(frame.subarray(offset, offset + FILE_WIRE_CHUNK_BYTES)))
  assert.equal(decoded.length, 1)
  assert.deepEqual(decoded[0].header, header)
  assert.deepEqual(decoded[0].data, bytes)
})

test("frame lengths are rejected before allocation and request IDs are validated", () => {
  const prefix = new Uint8Array(8)
  new DataView(prefix.buffer).setUint32(0, 0xffff_ffff)
  assert.throws(() => new FileFrameDecoder().push(prefix), /length/)
  new DataView(prefix.buffer).setUint32(0, 10)
  new DataView(prefix.buffer).setUint32(4, 0xffff_ffff)
  assert.throws(() => new FileFrameDecoder().push(prefix), /length/)
  assert.throws(() => new FileFrameDecoder().push(encodeFileFrame({ id: 0, value: null })), /header/)
  assert.throws(() => encodeFileFrame({ id: 1 }, new Uint8Array(FILE_CHUNK_BYTES + 1)), /limit/)
})
