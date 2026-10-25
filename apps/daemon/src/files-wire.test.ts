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

test("a maximum-sized operation reassembles from bounded DataChannel messages", () => {
  const bytes = new Uint8Array(FILE_CHUNK_BYTES).map((_, index) => index % 251)
  const frame = encodeFileFrame({ id: 1, method: "write", params: { transferId: "upload", path: "", offset: 0 } }, bytes)
  assert(frame.length > FILE_WIRE_CHUNK_BYTES)
  const decoder = new FileFrameDecoder()
  const decoded = []
  for (let offset = 0; offset < frame.length; offset += FILE_WIRE_CHUNK_BYTES) {
    const complete = decoder.push(frame.subarray(offset, offset + FILE_WIRE_CHUNK_BYTES))
    if (offset + FILE_WIRE_CHUNK_BYTES < frame.length) assert.deepEqual(complete, [])
    decoded.push(...complete)
  }
  assert.equal(decoded.length, 1)
  assert.equal(decoded[0].header.id, 1)
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
