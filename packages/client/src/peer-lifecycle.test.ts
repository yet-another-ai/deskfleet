import { afterEach, expect, test, vi } from "vitest"
import { createPeerDisconnectGuard, PEER_DISCONNECT_GRACE_MS } from "./peer-lifecycle.ts"

afterEach(() => { vi.useRealTimers() })

test("a recovered disconnected state never fails the peer", () => {
  vi.useFakeTimers()
  const failed = vi.fn()
  const guard = createPeerDisconnectGuard(failed)
  guard.update("disconnected")
  vi.advanceTimersByTime(20_000)
  expect(failed).not.toHaveBeenCalled()
  guard.update("connected")
  vi.advanceTimersByTime(PEER_DISCONNECT_GRACE_MS)
  expect(failed).not.toHaveBeenCalled()
  guard.update("disconnected")
  vi.advanceTimersByTime(PEER_DISCONNECT_GRACE_MS - 1)
  expect(failed).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(failed).toHaveBeenCalledOnce()
})

test("clearing or another state cancels the pending failure", () => {
  vi.useFakeTimers()
  const failed = vi.fn()
  const guard = createPeerDisconnectGuard(failed, 10_000)
  guard.update("disconnected")
  guard.clear()
  vi.advanceTimersByTime(10_000)
  expect(failed).not.toHaveBeenCalled()
  guard.update("disconnected")
  guard.update("new")
  vi.advanceTimersByTime(10_000)
  expect(failed).not.toHaveBeenCalled()
})
