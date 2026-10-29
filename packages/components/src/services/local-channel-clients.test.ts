import { flushPromises } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { LocalDataChannel, type LocalChannelEvent, type LocalChannelsApi } from "../../../client/src/local-channels.ts"
import { AgentClient } from "./agent-client.ts"
import { AgentMessageDecoder } from "./agent-stream.ts"
import { TerminalClient } from "./terminal-client.ts"

const clients: (AgentClient | TerminalClient)[] = []
beforeEach(() => { vi.stubGlobal("RTCPeerConnection", vi.fn(() => { throw new Error("WebRTC is disabled") })) })
afterEach(() => { for (const client of clients.splice(0)) client.close(); vi.unstubAllGlobals() })

function fixture(purpose: "agent" | "terminal") {
  const events = new Set<(event: LocalChannelEvent) => void>()
  let id = ""
  const bridge: LocalChannelsApi = {
    open: vi.fn(async () => {}), send: vi.fn(async () => {}), close: vi.fn(async () => {}),
    onEvent: listener => { events.add(listener); return () => { events.delete(listener) } },
  }
  const api = {
    connectChannel(connectionId: string) { id = connectionId; return new LocalDataChannel(bridge, { connectionId, purpose, teamId: "team", machineId: "machine" }) },
    prepare: vi.fn(async () => []), offer: vi.fn(async () => ({ sdp: "unused" })),
    candidate: vi.fn(async () => {}), close: vi.fn(async () => {}), onEvent: vi.fn(() => () => {}),
  }
  const message = (value: unknown) => {
    const data = purpose === "agent" ? new TextEncoder().encode(JSON.stringify(value) + "\n") : JSON.stringify(value)
    for (const listener of events) listener({ connectionId: id, kind: "message", data })
  }
  return { bridge, api, message }
}

test("Agent and Git RPC, notifications and reconnect work with WebRTC disabled", async () => {
  const f = fixture("agent"), state = vi.fn(), notify = vi.fn()
  const client = new AgentClient(f.api, state, notify); clients.push(client)
  await client.connect()
  const call = client.call("_deskfleet/git/status", { sessionId: "session", text: "你".repeat(12_000) })
  await flushPromises()
  const requests: Record<string, unknown>[] = []
  const decoder = new AgentMessageDecoder(value => requests.push(value as Record<string, unknown>))
  for (const [, data] of vi.mocked(f.bridge.send).mock.calls) {
    expect(data).toBeInstanceOf(Uint8Array)
    expect((data as Uint8Array).byteLength).toBeLessThanOrEqual(16 * 1024)
    decoder.write(data as Uint8Array)
  }
  expect(requests).toHaveLength(1)
  expect(requests[0]!.method).toBe("_deskfleet/git/status")
  f.message({ jsonrpc: "2.0", id: requests[0]!.id, result: { clean: true } })
  f.message({ jsonrpc: "2.0", method: "_deskfleet/session/event", params: { seq: "2" } })
  await expect(call).resolves.toEqual({ clean: true })
  expect(notify).toHaveBeenCalledWith({ method: "_deskfleet/session/event", params: { seq: "2" } })
  client.close()
  const sent = vi.mocked(f.bridge.send).mock.calls.length
  await client.connect()
  expect(f.bridge.send).toHaveBeenCalledTimes(sent)
  expect(f.bridge.open).toHaveBeenCalledTimes(2)
  expect(f.api.prepare).not.toHaveBeenCalled()
  expect(f.api.offer).not.toHaveBeenCalled()
  expect(RTCPeerConnection).not.toHaveBeenCalled()
  expect(state).toHaveBeenLastCalledWith("connected")
})

test("terminal attachment, input, output acknowledgment and resize share the direct channel", async () => {
  const f = fixture("terminal"), state = vi.fn(), listener = vi.fn()
  const client = new TerminalClient(f.api, state); clients.push(client)
  await client.connect()
  client.subscribe("shell", listener)
  const attach = client.call("attach", { sessionId: "shell" })
  await flushPromises()
  const request = JSON.parse(vi.mocked(f.bridge.send).mock.calls[0]![1] as string)
  f.message({ id: request.id, result: { id: "shell", status: "running" } })
  await attach
  f.message({ event: { kind: "output", sessionId: "shell", data: "aGk=", offset: 2 } })
  expect(f.bridge.send).toHaveBeenCalledTimes(1)
  listener.mock.calls[0]![1]()
  await flushPromises()
  expect(JSON.parse(vi.mocked(f.bridge.send).mock.calls[1]![1] as string)).toEqual({ ack: { sessionId: "shell", offset: 2 } })
  const input = client.input("shell", "hi"), resize = client.call("resize", { sessionId: "shell", cols: 90, rows: 25 })
  await flushPromises()
  for (const [, data] of vi.mocked(f.bridge.send).mock.calls.slice(2)) {
    const request = JSON.parse(data as string)
    expect(["input", "resize"]).toContain(request.method)
    f.message({ id: request.id, result: null })
  }
  await Promise.all([input, resize])
  expect(f.api.prepare).not.toHaveBeenCalled()
  expect(f.api.offer).not.toHaveBeenCalled()
  expect(RTCPeerConnection).not.toHaveBeenCalled()
  expect(state).toHaveBeenLastCalledWith("connected")
})

test.each(["agent", "terminal"] as const)("%s reports a local authorization failure without WebRTC fallback", async purpose => {
  const f = fixture(purpose), state = vi.fn()
  vi.mocked(f.bridge.open).mockRejectedValueOnce(new Error("Team membership was removed"))
  const client = purpose === "agent" ? new AgentClient(f.api, state, () => {}) : new TerminalClient(f.api, state)
  clients.push(client)
  await expect(client.connect()).rejects.toThrow("Team membership was removed")
  expect(state).toHaveBeenLastCalledWith("error", "Team membership was removed")
  expect(f.api.prepare).not.toHaveBeenCalled()
  expect(RTCPeerConnection).not.toHaveBeenCalled()
})

test.each(["agent", "terminal"] as const)("%s cancellation rejects immediately while local authorization is pending", async purpose => {
  const f = fixture(purpose), opened = Promise.withResolvers<void>()
  vi.mocked(f.bridge.open).mockReturnValueOnce(opened.promise)
  const client = purpose === "agent" ? new AgentClient(f.api, () => {}, () => {}) : new TerminalClient(f.api)
  clients.push(client)
  const pending = client.connect(), rejected = expect(pending).rejects.toThrow("connection closed")
  await flushPromises(); client.close(); await rejected
  opened.resolve(); await flushPromises()
  expect(f.bridge.close).toHaveBeenCalledTimes(2)
  expect(f.bridge.send).not.toHaveBeenCalled()
  expect(RTCPeerConnection).not.toHaveBeenCalled()
})
