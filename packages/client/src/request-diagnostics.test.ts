import { expect, test } from "vitest"
import { CentralRequestError, centralRequestFailure, deserializeCentralRequestError, serializeCentralRequestError } from "./request-diagnostics.ts"

test("summarizes nested network and aggregate causes without their addresses or messages", () => {
  const denied = Object.assign(new Error("connect ECONNREFUSED 192.0.2.10:443"), { code: "ECONNREFUSED", address: "192.0.2.10" })
  const timeout = Object.assign(new Error("connect to private.fleet.example timed out"), { code: "ETIMEDOUT" })
  const cause = new TypeError("fetch failed", { cause: new AggregateError([denied, timeout], "private host") })
  const error = centralRequestFailure(cause, {
    method: "POST", path: "/api/machines/private-machine/rpc?token=secret",
    body: { method: "_deskfleet/agent/configuration", params: { provider: "private-provider", model: "private-model" } }, elapsedMs: 12.6,
  })
  expect(error).toBeInstanceOf(CentralRequestError)
  expect(error.name).toBe("TypeError")
  expect(error.message).toBe("fetch failed")
  expect(error.cause).toBe(cause)
  expect(error.diagnostics).toEqual({
    method: "POST", route: "/api/machines/:machineId/rpc", rpcMethod: "_deskfleet/agent/configuration", elapsedMs: 13,
    causes: [{ name: "TypeError" }, { name: "AggregateError" }, { name: "Error", code: "ECONNREFUSED" }, { name: "Error", code: "ETIMEDOUT" }],
  })
  const serialized = JSON.stringify(serializeCentralRequestError(error))
  for (const secret of ["192.0.2.10", "private", "secret"]) expect(serialized).not.toContain(secret)
})

test("unknown routes, methods and cause properties cannot become diagnostic values", () => {
  const cause = Object.assign(new Error("fetch failed"), { name: "private-user", code: "private-key" })
  const error = centralRequestFailure(cause, {
    method: "private-method", path: "/api/private-workspace/private-file?token=secret", body: { method: "private-rpc" }, elapsedMs: 2,
  })
  expect(error.diagnostics).toEqual({ method: "unknown", route: "unknown", elapsedMs: 2, causes: [{ name: "Error" }] })
  const rpc = centralRequestFailure(cause, { method: "POST", path: "/api/machines/private/rpc", body: { method: "private-rpc" }, elapsedMs: 2 })
  expect(rpc.diagnostics.rpcMethod).toBeUndefined()
  expect(JSON.stringify(serializeCentralRequestError(error))).not.toContain("private")
})

test("route templates remove encoded identifiers and query values", () => {
  const error = centralRequestFailure(new TypeError("fetch failed"), {
    method: "GET", path: "/api/machines/user%2Fmachine/sessions/private-session/events?after=secret#private", elapsedMs: 1,
  })
  expect(error.diagnostics.route).toBe("/api/machines/:machineId/sessions/:sessionId/events")
})

test("cause summaries are bounded and terminate on cycles", () => {
  const cyclic = new Error("private")
  cyclic.cause = cyclic
  const cause = new AggregateError([cyclic, ...Array.from({ length: 20 }, () => Object.assign(new Error("private"), { code: "ENOTFOUND" }))])
  cause.cause = cause
  const error = centralRequestFailure(cause, { method: "GET", path: "/api/site", elapsedMs: 0 })
  expect(error.diagnostics.causes).toHaveLength(8)
  expect(error.diagnostics.causes[0]).toEqual({ name: "AggregateError" })
  expect(error.diagnostics.causes.at(-1)).toEqual({ name: "Error", code: "ENOTFOUND" })
})

test("IPC serialization preserves the request caller stack and excludes the local cause", () => {
  const cause = new TypeError("fetch failed", { cause: Object.assign(new Error("private host"), { code: "ENOTFOUND" }) })
  cause.stack = "TypeError: fetch failed"
  const error = centralRequestFailure(cause, { method: "GET", path: "/api/site", elapsedMs: 7 }, "Error\n    at loadCatalog (app.js:25:9)")
  const serialized = serializeCentralRequestError(error)!
  expect(serialized.stack).toBe("TypeError: fetch failed\n    at loadCatalog (app.js:25:9)")
  expect(serialized).not.toHaveProperty("cause")
  const restored = deserializeCentralRequestError(JSON.parse(JSON.stringify(serialized)))
  expect(restored).toBeInstanceOf(CentralRequestError)
  expect(restored.name).toBe("TypeError")
  expect(restored.message).toBe("fetch failed")
  expect(restored.stack).toBe(error.stack)
  expect(restored.diagnostics).toEqual(error.diagnostics)
  expect(restored.cause).toBeUndefined()
  expect(serializeCentralRequestError(new Error("other failure"))).toBeUndefined()
})

test("serialized main stacks omit installation paths while retaining source coordinates", () => {
  const error = centralRequestFailure(new TypeError("fetch failed"), { method: "GET", path: "/api/site", elapsedMs: 1 }, [
    "Error",
    "    at HttpCentralClient.request (file:///Users/alice/Applications/DeskFleet.app/Contents/Resources/app.asar/out/main/index.js:83:21)",
    "    at HttpCentralClient.rpc (/home/alice/deskfleet/resources/app.asar/out/main/index.js:191:39)",
    "    at invoke (C:\\Users\\alice\\AppData\\Local\\deskfleet\\app.asar\\out\\main\\index.js:98:15)",
    "    at file:///C:/Users/alice/Apps/deskfleet/main.js:42:9",
    "    at /Users/alice/Applications/DeskFleet Dev/main.js:10:5",
    "    at processTicksAndRejections (node:internal/process/task_queues:104:5)",
    "    at renderer (app://./assets/index-abc.js:20:8)",
    "    at browser (https://app.example/assets/index.js:30:7)",
  ].join("\n"))
  const serialized = serializeCentralRequestError(error)!
  expect(serialized.stack).toBe([
    "TypeError: fetch failed",
    "    at HttpCentralClient.request (app:///index.js:83:21)",
    "    at HttpCentralClient.rpc (app:///index.js:191:39)",
    "    at invoke (app:///index.js:98:15)",
    "    at app:///main.js:42:9",
    "    at app:///main.js:10:5",
    "    at processTicksAndRejections (node:internal/process/task_queues:104:5)",
    "    at renderer (app://./assets/index-abc.js:20:8)",
    "    at browser (https://app.example/assets/index.js:30:7)",
  ].join("\n"))
  for (const path of ["alice", "Users", "Applications", "home", "AppData", "app.asar"]) expect(serialized.stack).not.toContain(path)
  expect(error.stack).toContain("/Users/alice/")
})

test.each([
  "file:///Users/alice/Applications/DeskFleet.app/main.js:12:3",
  "/home/alice/deskfleet/main.js:12:3",
  "C:\\Users\\alice\\AppData\\Local\\deskfleet\\main.js:12:3",
  "file:///C:/Users/alice/AppData/Local/deskfleet/main.js:12:3",
])("serialized async stack frames omit local paths: %s", location => {
  const error = centralRequestFailure(new TypeError("fetch failed"), { method: "GET", path: "/api/site", elapsedMs: 1 }, [
    "Error",
    `    at async ${location}`,
    `    at async loadConfiguration (${location})`,
  ].join("\n"))
  const serialized = serializeCentralRequestError(error)!
  expect(serialized.stack).toBe([
    "TypeError: fetch failed",
    "    at async app:///main.js:12:3",
    "    at async loadConfiguration (app:///main.js:12:3)",
  ].join("\n"))
  expect(serialized.stack).not.toContain("alice")
  expect(error.stack).toContain(location)
})
