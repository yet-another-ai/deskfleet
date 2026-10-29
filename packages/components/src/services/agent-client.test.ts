import { flushPromises } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { AgentSignalingApi } from "../../../client/src/agent.ts"
import { LocalDataChannel, type LocalChannelsApi } from "../../../client/src/local-channels.ts"
import { deferred } from "../test/desktop-media.ts"
import { AgentClient } from "./agent-client.ts"
import { AgentMessageDecoder } from "./agent-stream.ts"
class TestChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting"
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null
  send = vi.fn<(bytes: Uint8Array) => void>()
  close = vi.fn(() => { this.readyState = "closed"; this.dispatchEvent(new Event("close")) })
  open(): void { this.readyState = "open"; this.onopen?.() }
  message(value: unknown): void { const bytes = new TextEncoder().encode(JSON.stringify(value) + "\n"); this.onmessage?.({ data: bytes.buffer }) }
  sent(): Record<string, unknown>[] { const messages: Record<string, unknown>[] = []; const decoder = new AgentMessageDecoder(value => messages.push(value as Record<string, unknown>)); for (const [bytes] of this.send.mock.calls) decoder.write(bytes); return messages }
}
class TestPeer {
  static instances: TestPeer[] = []
  connectionState: RTCPeerConnectionState = "new"
  sctp = { maxMessageSize: 4096 }
  onicecandidate: unknown = null
  onconnectionstatechange: unknown = null
  channel = new TestChannel()
  createDataChannel = vi.fn(() => this.channel)
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "offer" }))
  setLocalDescription = vi.fn(async () => {})
  setRemoteDescription = vi.fn(async () => {})
  addIceCandidate = vi.fn(async () => {})
  close = vi.fn()
  constructor() { TestPeer.instances.push(this) }
}
const clients: AgentClient[] = []
function setup(request?: ConstructorParameters<typeof AgentClient>[3]) {
  const api: AgentSignalingApi = { offer: vi.fn(async () => ({ sdp: "answer" })), candidate: vi.fn(async () => {}), close: vi.fn(async () => {}), onEvent: vi.fn(() => () => {}) }
  const notify = vi.fn(); const state = vi.fn()
  const client = new AgentClient(api, state, notify, request); clients.push(client)
  return { client, api, notify, state }
}
async function connect(client: AgentClient) {
  const pending = client.connect(); await flushPromises(); const peer = TestPeer.instances.at(-1)!; peer.channel.open(); await pending; return peer
}
beforeEach(() => { TestPeer.instances = []; vi.stubGlobal("RTCPeerConnection", TestPeer) })
afterEach(() => { for (const client of clients.splice(0)) client.close(); vi.unstubAllGlobals() })

test("sends serialized UTF-8 frames within negotiated size and resumes after backpressure", async () => {
  const { client } = setup(); const peer = await connect(client)
  expect(peer.createDataChannel).toHaveBeenCalledWith("deskfleet-acp", { ordered: true })
  peer.channel.bufferedAmount = 300 * 1024
  const first = client.call("first", { text: "你好".repeat(2000) })
  const second = client.call("second", {})
  await flushPromises(); expect(peer.channel.send).not.toHaveBeenCalled()
  peer.channel.bufferedAmount = 0; peer.channel.dispatchEvent(new Event("bufferedamountlow"))
  await flushPromises()
  expect(peer.channel.send.mock.calls.every(([bytes]) => bytes.length <= 4096)).toBe(true)
  const messages = peer.channel.sent()
  expect(messages.map(message => message.method)).toEqual(["first", "second"])
  expect(messages[0]!.params).toEqual({ text: "你好".repeat(2000) })
  peer.channel.message({ jsonrpc: "2.0", id: messages[0]!.id, result: 1 }); peer.channel.message({ jsonrpc: "2.0", id: messages[1]!.id, result: 2 })
  await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
})

test("a pending permission callback does not block journal events or unrelated RPC responses", async () => {
  const permission = deferred<unknown>(); const { client, notify } = setup(() => permission.promise); const peer = await connect(client)
  peer.channel.message({ jsonrpc: "2.0", id: "permission-1", method: "session/request_permission", params: {} })
  const query = client.call("history", {}); await flushPromises()
  peer.channel.message({ jsonrpc: "2.0", method: "_deskfleet/session/event", params: { seq: "1" } })
  peer.channel.message({ jsonrpc: "2.0", id: peer.channel.sent()[0]!.id, result: [] })
  await expect(query).resolves.toEqual([])
  expect(notify).toHaveBeenCalledWith({ method: "_deskfleet/session/event", params: { seq: "1" } })
  permission.resolve({ outcome: { outcome: "cancelled" } }); await flushPromises()
  expect(peer.channel.sent().at(-1)).toEqual({ jsonrpc: "2.0", id: "permission-1", result: { outcome: { outcome: "cancelled" } } })
})

test("disconnect rejects mutations and reconnect never replays them", async () => {
  const { client } = setup(); await connect(client)
  const pending = client.call("_deskfleet/input/submit", { operationId: "same-operation" })
  const rejected = expect(pending).rejects.toThrow("connection closed")
  await flushPromises(); client.close(); await rejected
  const next = await connect(client)
  expect(next.channel.send).not.toHaveBeenCalled()
})

test("changing an existing client's transport never replays an accepted command", async () => {
  const { client, api } = setup(), peer = await connect(client)
  const accepted = client.call("_deskfleet/input/submit", { operationId: "accepted-operation" })
  await flushPromises()
  peer.channel.message({ jsonrpc: "2.0", id: peer.channel.sent()[0]!.id, result: { accepted: true } })
  await accepted
  client.close()
  const bridge: LocalChannelsApi = { open: vi.fn(async () => {}), send: vi.fn(async () => {}), close: vi.fn(async () => {}), onEvent: () => () => {} }
  api.connectChannel = connectionId => new LocalDataChannel(bridge, { connectionId, teamId: "team", machineId: "machine", purpose: "agent" })
  await client.connect()
  expect(bridge.send).not.toHaveBeenCalled()
  expect(api.offer).toHaveBeenCalledOnce()
  client.close()
  api.connectChannel = undefined
  const next = await connect(client)
  expect(next.channel.send).not.toHaveBeenCalled()
  expect(api.offer).toHaveBeenCalledTimes(2)
})

test("releasing an in-flight offer closes a late peer answer too", async () => {
  const { client, api } = setup(); const answer = deferred<{ sdp: string }>(); vi.mocked(api.offer).mockReturnValue(answer.promise)
  const pending = client.connect(); const rejected = expect(pending).rejects.toThrow("connection closed")
  await flushPromises(); client.close(); await rejected; answer.resolve({ sdp: "late" }); await flushPromises()
  expect(api.close).toHaveBeenCalledTimes(2)
})

test("surfaces the saved relay denial only for transport failure", async () => {
  const { client, api, state } = setup()
  const detail = "Direct connection failed. The Free plan does not include TURN relay."
  Object.assign(api, { connectionFailure: () => detail })
  const pending = client.connect()
  const rejected = expect(pending).rejects.toThrow(detail)
  await flushPromises()
  const peer = TestPeer.instances.at(-1)!
  peer.channel.onclose?.()
  await rejected
  expect(state).toHaveBeenLastCalledWith("error", detail)
})
