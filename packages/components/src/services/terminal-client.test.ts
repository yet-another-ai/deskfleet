import { flushPromises } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { DesktopEvent } from "../../../client/src/desktop-media.ts"
import type { TerminalSignalingApi } from "../../../client/src/terminal.ts"
import { deferred } from "../test/desktop-media.ts"
import { decodeTerminalBytes, TerminalClient } from "./terminal-client.ts"

class TestChannel {
  readyState: RTCDataChannelState = "connecting"
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  send = vi.fn<(data: string) => void>()
  close = vi.fn(() => { this.readyState = "closed" })
  open(): void { this.readyState = "open"; this.onopen?.() }
  message(data: unknown): void { this.onmessage?.({ data: JSON.stringify(data) }) }
}

class TestPeer {
  static instances: TestPeer[] = []
  connectionState: RTCPeerConnectionState = "new"
  onicecandidate: ((event: { candidate: { toJSON: () => RTCIceCandidateInit } }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  channel = new TestChannel()
  createDataChannel = vi.fn(() => this.channel)
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "data-offer" }))
  setLocalDescription = vi.fn(async () => {})
  setRemoteDescription = vi.fn(async () => {})
  addIceCandidate = vi.fn(async (_candidate: RTCIceCandidateInit) => {})
  close = vi.fn(() => { this.connectionState = "closed" })
  constructor() { TestPeer.instances.push(this) }
}

const clients: TerminalClient[] = []

function setup() {
  const listeners = new Set<(event: DesktopEvent) => void>()
  const api = {
    offer: vi.fn<TerminalSignalingApi["offer"]>(async () => ({ sdp: "answer" })),
    candidate: vi.fn<TerminalSignalingApi["candidate"]>(async () => {}),
    close: vi.fn<TerminalSignalingApi["close"]>(async () => {}),
    onEvent: vi.fn<TerminalSignalingApi["onEvent"]>((listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }),
  }
  const state = vi.fn()
  const client = new TerminalClient(api, state)
  clients.push(client)
  return { client, api, state, emit: (event: DesktopEvent) => { for (const listener of listeners) listener(event) } }
}

async function connected(client: TerminalClient) {
  const connecting = client.connect()
  await flushPromises()
  const peer = TestPeer.instances.at(-1)!
  peer.channel.open()
  await connecting
  return peer
}

beforeEach(() => {
  TestPeer.instances = []
  vi.stubGlobal("RTCPeerConnection", TestPeer)
})
afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  vi.unstubAllGlobals()
})

test("negotiates a reliable data-only channel and queues both directions of early ICE", async () => {
  const { client, api, emit, state } = setup()
  const offer = deferred<{ sdp: string }>()
  api.offer.mockReturnValueOnce(offer.promise)
  const connecting = client.connect()
  await flushPromises()
  const peer = TestPeer.instances[0]!
  const sessionId = api.offer.mock.calls[0]![0].sessionId
  peer.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "local", sdpMLineIndex: 0 }) } })
  emit({ sessionId, kind: "iceCandidate", candidate: { candidate: "remote", sdpMlineIndex: 0 } })
  peer.channel.open()
  expect(api.candidate).not.toHaveBeenCalled()
  expect(peer.addIceCandidate).not.toHaveBeenCalled()
  offer.resolve({ sdp: "answer" })
  await connecting
  await flushPromises()
  expect(peer.createDataChannel).toHaveBeenCalledWith("deskfleet-terminal", { ordered: true })
  expect(api.offer.mock.calls[0]![0]).toEqual({ sessionId, sdp: "data-offer" })
  expect(api.candidate).toHaveBeenCalledWith(sessionId, { candidate: "local", sdpMlineIndex: 0 })
  expect(peer.addIceCandidate).toHaveBeenCalledWith({ candidate: "remote", sdpMLineIndex: 0 })
  expect(state).toHaveBeenLastCalledWith("connected")
})

test("acknowledges output only after the consumer finishes writing it", async () => {
  const { client } = setup()
  const peer = await connected(client)
  const listener = vi.fn()
  const detach = client.subscribe("terminal-1", listener)
  peer.channel.message({ event: { kind: "output", sessionId: "terminal-1", data: "aGk=", offset: 2 } })
  expect(peer.channel.send).not.toHaveBeenCalled()
  listener.mock.calls[0]![1]()
  expect(JSON.parse(peer.channel.send.mock.calls[0]![0])).toEqual({ ack: { sessionId: "terminal-1", offset: 2 } })
  detach()
  await flushPromises()
  const request = JSON.parse(peer.channel.send.mock.calls[1]![0])
  expect(request).toMatchObject({ method: "detach", params: { sessionId: "terminal-1" } })
  peer.channel.message({ id: request.id, result: null })
})

test("serializes pasted UTF-8 in bounded chunks and rejects input beyond its pending limit", async () => {
  const { client } = setup()
  const peer = await connected(client)
  const text = "你好".repeat(2_000)
  const input = client.input("terminal-1", text)
  await flushPromises()
  expect(peer.channel.send).toHaveBeenCalledTimes(1)
  const first = JSON.parse(peer.channel.send.mock.calls[0]![0])
  expect(decodeTerminalBytes(first.params.data).byteLength).toBe(8192)
  peer.channel.message({ id: first.id, result: null })
  await flushPromises()
  const second = JSON.parse(peer.channel.send.mock.calls[1]![0])
  peer.channel.message({ id: second.id, result: null })
  await input
  const combined = new Uint8Array([...decodeTerminalBytes(first.params.data), ...decodeTerminalBytes(second.params.data)])
  expect(new TextDecoder().decode(combined)).toBe(text)
  await expect(client.input("terminal-1", "x".repeat(256 * 1024 + 1))).rejects.toThrow("pending limit")
})

test("closing rejects in-flight requests and a later connection does not recreate a terminal", async () => {
  const { client, api } = setup()
  const peer = await connected(client)
  const request = client.call("attach", { sessionId: "terminal-1" })
  const rejected = expect(request).rejects.toThrow("connection closed")
  await flushPromises()
  client.close()
  await rejected
  expect(peer.close).toHaveBeenCalledOnce()
  expect(api.close).toHaveBeenCalledOnce()
  const next = await connected(client)
  expect(next.channel.send).not.toHaveBeenCalled()
  expect(api.offer).toHaveBeenCalledTimes(2)
})

test("coalesces keys typed during a pending write into the next ordered chunk", async () => {
  const { client } = setup()
  const peer = await connected(client)
  const first = client.input("terminal-1", "a")
  await flushPromises()
  const second = client.input("terminal-1", "b")
  const third = client.input("terminal-1", "c")
  const request = JSON.parse(peer.channel.send.mock.calls[0]![0])
  peer.channel.message({ id: request.id, result: null })
  await flushPromises()
  expect(peer.channel.send).toHaveBeenCalledTimes(2)
  const combined = JSON.parse(peer.channel.send.mock.calls[1]![0])
  expect(new TextDecoder().decode(decodeTerminalBytes(combined.params.data))).toBe("bc")
  peer.channel.message({ id: combined.id, result: null })
  await Promise.all([first, second, third])
})

test("a cancelled offer is closed again if the daemon finishes it late", async () => {
  const { client, api } = setup()
  const answer = deferred<{ sdp: string }>()
  api.offer.mockReturnValue(answer.promise)
  const connecting = client.connect()
  const rejected = expect(connecting).rejects.toThrow("connection closed")
  await flushPromises()
  const id = api.offer.mock.calls[0]![0].sessionId
  client.close()
  await rejected
  answer.resolve({ sdp: "late-answer" })
  await flushPromises()
  expect(api.close).toHaveBeenNthCalledWith(1, id)
  expect(api.close).toHaveBeenNthCalledWith(2, id)
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
