import { expect, test, vi } from "vitest"
import { AGENT_MESSAGE_BYTES } from "../../../../apps/daemon/src/agent-protocol.ts"
import { AgentMessageDecoder } from "./agent-stream.ts"
test("reassembles split UTF-8 and multiple NDJSON messages independently of channel frames", () => {
  const receive = vi.fn()
  const decoder = new AgentMessageDecoder(receive)
  const bytes = new TextEncoder().encode('{"text":"你好"}\n{"id":2}\n')
  for (const byte of bytes) decoder.write(new Uint8Array([byte]))
  expect(receive.mock.calls).toEqual([[{ text: "你好" }], [{ id: 2 }]])
})
test("bounds reconstructed message bytes and rejects corrupt UTF-8", () => {
  const decoder = new AgentMessageDecoder(() => {})
  const chunk = new Uint8Array(16 * 1024).fill(32)
  for (let size = 0; size < AGENT_MESSAGE_BYTES; size += chunk.length) decoder.write(chunk)
  expect(() => decoder.write(new Uint8Array([32]))).toThrow("32 MiB")
  expect(() => new AgentMessageDecoder(() => {}).write(new Uint8Array([255, 10]))).toThrow()
})
