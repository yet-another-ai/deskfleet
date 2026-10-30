import { expect, test, vi } from "vitest"
import { centralBridgeClient, centralIpcFailure, type CentralBridge, type CentralIpcResult } from "./central-bridge.ts"
import { CentralRequestError, centralRequestFailure } from "./request-diagnostics.ts"

function bridge(result: CentralIpcResult): CentralBridge {
  return { invoke: vi.fn(async () => result), onEvent: vi.fn(() => () => {}), context: vi.fn() }
}

test.each([undefined, null, { user: { id: "user" } }])("central success preserves its result %j", async value => {
  const transport = bridge({ ok: true, value })
  const report = vi.fn()
  const api = centralBridgeClient(transport, report)
  expect(await api.status()).toEqual(value)
  expect(transport.invoke).toHaveBeenCalledExactlyOnceWith("status", [])
  expect(report).not.toHaveBeenCalled()
  const listener = vi.fn()
  api.onEvent(listener)
  expect(transport.onEvent).toHaveBeenCalledExactlyOnceWith(listener)
})

test("diagnostic errors cross serialization and are reported before reaching the caller", async () => {
  const original = centralRequestFailure(new TypeError("fetch failed", { cause: Object.assign(new Error("connection"), { code: "ECONNREFUSED" }) }), {
    method: "POST", path: "/api/machines/private-machine/rpc", body: { method: "_deskfleet/session/configure", params: { model: "private-model" } }, elapsedMs: 12,
  }, "Error\n    at request (app.js:12:3)")
  const result = structuredClone(centralIpcFailure(original))
  const report = vi.fn()
  const api = centralBridgeClient(bridge(result), report)
  const failure = await api.rpc("private-machine", "_deskfleet/session/configure", {}).catch(error => error)
  if (!(failure instanceof CentralRequestError)) throw new Error("Expected a central transport failure")
  expect(report).toHaveBeenCalledExactlyOnceWith(failure)
  expect(failure.diagnostics.causes).toEqual([{ name: "TypeError" }, { name: "Error", code: "ECONNREFUSED" }])
  expect(failure.stack).toContain("app.js:12:3")
  expect(failure.cause).toBeUndefined()
  expect(failure.message).toBe("Error invoking remote method 'deskfleet:central': TypeError: fetch failed")
  expect(JSON.stringify(result)).not.toContain("private-")
})

test("ordinary operation errors retain their message without becoming network reports", async () => {
  const report = vi.fn()
  const api = centralBridgeClient(bridge(centralIpcFailure(new Error("Permission denied"))), report)
  await expect(api.teams()).rejects.toThrow("Error invoking remote method 'deskfleet:central': Error: Permission denied")
  expect(report).not.toHaveBeenCalled()
})

test("a failed reporter cannot replace the caller's network error", async () => {
  const original = centralRequestFailure(new TypeError("fetch failed"), { method: "GET", path: "/api/me", elapsedMs: 1 })
  const api = centralBridgeClient(bridge(centralIpcFailure(original)), () => { throw new Error("reporting failed") })
  await expect(api.status()).rejects.toThrow("TypeError: fetch failed")
})
