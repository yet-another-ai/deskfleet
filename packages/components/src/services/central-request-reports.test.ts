import { afterEach, expect, test, vi } from "vitest"
import { centralRequestFailure, type RequestFailureKind, type RequestTrigger } from "@deskfleet/client/request-diagnostics"
import { CentralRequestReports } from "./central-request-reports.ts"

afterEach(() => { vi.useRealTimers() })
function failure(trigger: RequestTrigger = "background", kind: RequestFailureKind = "network", path = "/api/site", status?: number) {
  const error = centralRequestFailure(new TypeError("fetch failed"), { method: "GET", path, elapsedMs: 20, kind, status })
  error.diagnostics.trigger = trigger
  return error
}

test("emits the first background failure and counts every repeat even when the burst stops", () => {
  vi.useFakeTimers()
  const emit = vi.fn()
  const reports = new CentralRequestReports(emit)
  const first = failure()
  reports.capture(first)
  reports.capture(first)
  reports.capture(failure())
  reports.capture(failure())
  expect(emit).toHaveBeenCalledExactlyOnceWith(first, { occurrences: 1, window_ms: 0, summary: false })
  vi.advanceTimersByTime(60_000)
  expect(emit).toHaveBeenCalledTimes(2)
  expect(emit.mock.calls[1]![1]).toEqual({ occurrences: 2, window_ms: 60_000, summary: true })
  expect(emit.mock.calls[1]![0].diagnostics).toEqual(first.diagnostics)
  reports.capture(failure())
  expect(emit).toHaveBeenCalledTimes(3)
  reports.flush()
  expect(vi.getTimerCount()).toBe(0)
})

test("only repeated background transport, timeout, 429 and server failures are collapsed", () => {
  vi.useFakeTimers()
  const emit = vi.fn()
  const reports = new CentralRequestReports(emit)
  for (const [trigger, kind, status] of [["user", "network"], ["unknown", "network"], ["background", "decode"], ["background", "http", 400]] as const) {
    reports.capture(failure(trigger, kind, "/api/site", status))
    reports.capture(failure(trigger, kind, "/api/site", status))
  }
  expect(emit).toHaveBeenCalledTimes(8)
  for (const [kind, status] of [["timeout"], ["http", 429], ["http", 503]] as const) {
    reports.capture(failure("background", kind, "/api/site", status))
    reports.capture(failure("background", kind, "/api/site", status))
  }
  expect(emit).toHaveBeenCalledTimes(11)
  reports.capture(failure("background", "timeout", "/api/teams"))
  expect(emit).toHaveBeenCalledTimes(12)
  reports.flush()
  expect(emit).toHaveBeenCalledTimes(15)
  expect(vi.getTimerCount()).toBe(0)
})

test("bounds active buckets and flushes counts on eviction and shutdown", () => {
  vi.useFakeTimers()
  const emit = vi.fn()
  const reports = new CentralRequestReports(emit)
  for (let status = 500; status <= 628; status++) {
    reports.capture(failure("background", "http", "/api/site", status))
    reports.capture(failure("background", "http", "/api/site", status))
  }
  expect(vi.getTimerCount()).toBe(128)
  expect(emit.mock.calls.filter(([, repetition]) => repetition.summary)).toHaveLength(1)
  reports.flush()
  expect(vi.getTimerCount()).toBe(0)
  expect(emit.mock.calls.reduce((count, [, repetition]) => count + repetition.occurrences, 0)).toBe(258)
})
