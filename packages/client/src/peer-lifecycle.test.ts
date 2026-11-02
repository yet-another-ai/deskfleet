import { afterEach, expect, test, vi } from "vitest"
import { createPeerDisconnectGuard } from "./peer-lifecycle.ts"

afterEach(() => { vi.useRealTimers() })

test("a recovered disconnected state never fails the peer", () => {
  vi.useFakeTimers()
  const failed = vi.fn()
  const guard = createPeerDisconnectGuard(failed, 10_000)
  guard.update("disconnected")
  vi.advanceTimersByTime(9_999)
  expect(failed).not.toHaveBeenCalled()
  guard.update("connected")
  vi.advanceTimersByTime(10_000)
  expect(failed).not.toHaveBeenCalled()
  guard.update("disconnected")
  vi.advanceTimersByTime(10_000)
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
