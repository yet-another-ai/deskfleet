import { expect, test } from "vitest"
import { HttpError } from "@deskfleet/client/http-central"
import { errorPresentation } from "./error-presentation.ts"

test.each([
  [401, "unauthorized"], [403, "forbidden"], [404, "notFound"], [429, "rateLimited"], [503, "server"],
])("formats HTTP status %s without depending on server wording", (status, kind) => {
  expect(errorPresentation(new HttpError(status as number, "Original failure"))).toEqual({ kind, detail: "Original failure", billing: false })
})

test("machine offline takes precedence over a general service error", () => {
  expect(errorPresentation(new HttpError(503, "target machine is unavailable", undefined, "machine_offline")).kind).toBe("machineOffline")
})

test.each(["free_plan", "turn_quota_exhausted", "metering_unavailable"] as const)("uses the structured relay reason %s", reason => {
  expect(errorPresentation({ code: reason, message: "Unrelated wording" })).toEqual({ kind: reason, detail: "Unrelated wording", billing: reason !== "metering_unavailable" })
  expect(errorPresentation("Original failure", reason).kind).toBe(reason)
})

test("does not offer billing from words inside an unrelated error", () => {
  expect(errorPresentation("TURN relay free_plan or turn_quota_exhausted failed")).toEqual({ kind: "generic", detail: "TURN relay free_plan or turn_quota_exhausted failed", billing: false })
})

test("formats standard network failures and retains custom failures", () => {
  expect(errorPresentation(new TypeError("Failed to fetch")).kind).toBe("network")
  expect(errorPresentation("Failed to fetch repository metadata").kind).toBe("generic")
  expect(errorPresentation({ reason: "custom", attempts: 2 }).detail).toBe('{\n  "reason": "custom",\n  "attempts": 2\n}')
  expect(errorPresentation(null).detail).toBeUndefined()
})
