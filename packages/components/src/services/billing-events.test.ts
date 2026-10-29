import { expect, test } from "vitest"
import { HttpError } from "@deskfleet/client/http-central"
import { billingFailure, billingReturn } from "./billing-events.ts"

test("return markers accept only the navigation taxonomy", () => {
  for (const source of ["checkout_success", "checkout_cancel", "portal"] as const) expect(billingReturn(source)).toBe(source)
  expect(billingReturn("paid")).toBeUndefined()
  expect(billingReturn("private URL")).toBeUndefined()
  expect(billingReturn(null)).toBeUndefined()
})

test("payment errors never use a message or an arbitrary provider code as telemetry", () => {
  expect(billingFailure(new HttpError(403, "private message"))).toBe("access_denied")
  expect(billingFailure(new HttpError(500, "private message", undefined, "private-code"))).toBe("server_error")
  expect(billingFailure(new HttpError(400, "private message", undefined, "private-code"))).toBe("request_rejected")
  expect(billingFailure(new Error("private message"))).toBe("network_or_open_failed")
})
