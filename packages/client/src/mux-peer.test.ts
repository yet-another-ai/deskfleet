import { afterEach, expect, test, vi } from "vitest"
import { browserMuxPeer } from "./mux-peer.ts"
import { MUX_LABELS } from "@deskfleet/protocol/mux"

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

async function fixture() {
  class Channel extends EventTarget {
    readyState = "open"
    bufferedAmount = 0
    bufferedAmountLowThreshold = 0
    send = vi.fn()
    close() { this.readyState = "closed" }
  }
  const channels = new Map<string, Channel>()
  vi.stubGlobal("RTCPeerConnection", class {
    createDataChannel(label: string) { const channel = new Channel(); channels.set(label, channel); return channel }
    close() {}
  })
  const events = { data: vi.fn(), open: vi.fn(), candidate: vi.fn(), state: vi.fn(), fail: vi.fn() }
  const peer = await browserMuxPeer([], events)
  return { peer, events, channel: channels.get(MUX_LABELS.agent)! }
}

test("a Mux send waits through six seconds of congestion and sends the frame once capacity returns", async () => {
  vi.useFakeTimers()
  const { peer, channel, events } = await fixture()
  try {
    channel.bufferedAmount = 64 * 1024
    const bytes = new Uint8Array([1, 2, 3])
    const sending = peer.send("agent", bytes)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(channel.send).not.toHaveBeenCalled()
    expect(events.fail).not.toHaveBeenCalled()
    channel.bufferedAmount = 0
    channel.dispatchEvent(new Event("bufferedamountlow"))
    await sending
    expect(channel.send).toHaveBeenCalledExactlyOnceWith(bytes)
    expect(vi.getTimerCount()).toBe(0)
  } finally { await peer.close() }
})

test("a permanently stalled Mux send rejects at thirty seconds and removes its capacity listeners", async () => {
  vi.useFakeTimers()
  const { peer, channel } = await fixture()
  try {
    channel.bufferedAmount = 64 * 1024
    const removed = vi.spyOn(channel, "removeEventListener")
    let failed = false
    const sending = peer.send("agent", new Uint8Array([1])).catch(error => { failed = true; throw error })
    const rejected = expect(sending).rejects.toThrow("Mux send interrupted")
    await vi.advanceTimersByTimeAsync(29_999)
    expect(failed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(removed).toHaveBeenCalledWith("bufferedamountlow", expect.any(Function))
    channel.dispatchEvent(new Event("bufferedamountlow"))
    expect(channel.send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  } finally { await peer.close() }
})
