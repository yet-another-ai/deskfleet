import { createApp, h } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { captureEvent, getClient, init, type ErrorEvent } from "@sentry/vue"
import { centralRequestFailure } from "@deskfleet/client/request-diagnostics"
import { captureCentralRequestError, initializeErrorReporting, installErrorReporting, shutdownErrorReporting } from "./error-reporting.ts"

// Exercise the real SDK and Vue error handler; replace only outbound delivery.
type Options = NonNullable<Parameters<typeof init>[0]>
type Envelope = Parameters<ReturnType<NonNullable<Options["transport"]>>["send"]>[0]
const transport = vi.hoisted(() => ({
  send: vi.fn(async (_envelope: Envelope) => ({ statusCode: 200 })),
  flush: vi.fn(async () => true),
}))
vi.mock("@sentry/vue", async importOriginal => {
  const sdk = await importOriginal<typeof import("@sentry/vue")>()
  return { ...sdk, init: vi.fn((options: Parameters<typeof sdk.init>[0]) => sdk.init({ ...options, transport: () => transport })) }
})

const apps: ReturnType<typeof createApp>[] = []
beforeEach(() => {
  vi.stubEnv("VITE_SENTRY_DSN", "https://public@sentry.example.com/42")
  vi.stubEnv("VITE_SENTRY_ENVIRONMENT", " staging ")
  vi.stubEnv("VITE_SENTRY_RELEASE", " deskfleet@0.2.1 ")
})
afterEach(async () => {
  for (const app of apps.splice(0)) app.unmount()
  await shutdownErrorReporting()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

function events(): ErrorEvent[] {
  return transport.send.mock.calls.flatMap(([envelope]) => envelope[1]
    .filter(([header]) => header.type === "event").map(([, event]) => event as ErrorEvent))
}

function requestFailure(rpcMethod = "_deskfleet/agent/configuration", code = "ENOTFOUND"): Error {
  return centralRequestFailure(new TypeError("fetch failed", {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND private-host"), { code }),
  }), {
    method: "POST", path: "/api/machines/private-machine/rpc?token=private-query", elapsedMs: 123.4,
    body: { method: rpcMethod, params: { provider: "private-provider", workspaceId: "private-workspace" } },
  })
}

test.each([undefined, "", "  ", "invalid", "https://sentry.example.com/42"])("does not initialize or change Vue handlers with DSN %s", dsn => {
  vi.stubEnv("VITE_SENTRY_DSN", dsn)
  const app = createApp({ render: () => null })
  const handler = vi.fn()
  app.config.errorHandler = handler
  initializeErrorReporting("web")
  captureCentralRequestError(requestFailure())
  installErrorReporting(app)
  expect(init).not.toHaveBeenCalled()
  expect(transport.send).not.toHaveBeenCalled()
  expect(app.config.errorHandler).toBe(handler)
})

test("reports desktop OS and runtime versions for errors without a machine identity", async () => {
  initializeErrorReporting("desktop", {
    os: { name: "macOS", version: "15.6" }, architecture: "arm64", appVersion: "0.2.2",
    electronVersion: "45.0.0", nodeVersion: "24.0.0", chromeVersion: "152.0.0.0",
  })
  captureEvent({ message: "desktop failure" })
  await getClient()?.flush(1000)
  expect(events()[0]?.contexts).toMatchObject({
    os: { name: "macOS", version: "15.6" }, device: { arch: "arm64" }, app: { app_version: "0.2.2" },
    runtime: { name: "Electron", version: "45.0.0" }, node: { name: "Node.js", version: "24.0.0" },
    browser: { name: "Chrome", version: "152.0.0.0" },
  })
})

test("reports handled central transport failures with bounded diagnostics and deduplicates the same rejection", async () => {
  initializeErrorReporting("desktop")
  const error = requestFailure()
  captureCentralRequestError(error)
  await getClient()?.flush(1000)
  expect(events()).toHaveLength(1)
  expect(events()[0]).toMatchObject({
    exception: { values: [{ type: "TypeError", value: "fetch failed" }] },
    tags: { platform: "desktop", "central.method": "POST", "central.route": "/api/machines/:machineId/rpc", "central.rpc_method": "_deskfleet/agent/configuration", "central.cause_code": "ENOTFOUND" },
    contexts: { central_request: {
      method: "POST", route: "/api/machines/:machineId/rpc", rpc_method: "_deskfleet/agent/configuration", elapsed_ms: 123,
      causes: ["TypeError", "Error: ENOTFOUND"],
    } },
  })
  expect(events()[0]?.exception?.values?.[0]?.stacktrace?.frames?.length).toBeGreaterThan(0)
  expect(JSON.stringify(events())).not.toContain("private")
  globalThis.onunhandledrejection?.call(window, { reason: error } as PromiseRejectionEvent)
  await getClient()?.flush(1000)
  expect(events()).toHaveLength(1)
})

test("leaves ordinary errors to their existing handlers", async () => {
  initializeErrorReporting("desktop")
  captureCentralRequestError(new Error("Provider rejected the model"))
  await getClient()?.flush(1000)
  expect(events()).toHaveLength(0)
})

test("retains consecutive failures with the same stack but distinct RPC methods or causes", async () => {
  initializeErrorReporting("desktop")
  const requests = [
    ["_deskfleet/agent/configuration", "ENOTFOUND"],
    ["_deskfleet/session/configure", "ENOTFOUND"],
    ["_deskfleet/session/configure", "ETIMEDOUT"],
  ] as const
  for (const [method, code] of requests) {
    const error = requestFailure(method, code)
    error.stack = "TypeError: fetch failed\n    at HttpCentralClient.request (https://app.example/assets/main.js:10:20)"
    captureCentralRequestError(error)
    await getClient()?.flush(1000)
  }
  expect(events()).toHaveLength(3)
  expect(events().map(event => event.fingerprint)).toEqual(requests.map(([method, code]) => [
    "{{ default }}", "POST", "/api/machines/:machineId/rpc", method, code,
  ]))
})

test("captures real Vue errors from multiple apps through one client without props", async () => {
  initializeErrorReporting("desktop")
  initializeErrorReporting("desktop")
  const original = vi.fn()
  for (const name of ["Root", "MachineSurface"]) {
    const app = createApp({ name, props: ["secret"], render() { throw new Error(`${name} failed`) } }, { secret: "private-prop" })
    app.config.errorHandler = original
    installErrorReporting(app)
    installErrorReporting(app)
    apps.push(app)
    app.mount(document.createElement("div"))
  }
  await vi.waitFor(() => expect(events()).toHaveLength(2))
  expect(init).toHaveBeenCalledTimes(1)
  expect(original).toHaveBeenCalledTimes(2)
  expect(events().map(event => event.exception?.values?.[0]?.value)).toEqual(["Root failed", "MachineSurface failed"])
  for (const event of events()) {
    expect(event).toMatchObject({ environment: "staging", release: "deskfleet@0.2.1", tags: { platform: "desktop" } })
    expect(event.contexts?.vue).toBeDefined()
  }
  expect(JSON.stringify(events())).not.toContain("private-prop")
  // Unmounting a machine surface must not close the document's client.
  apps.pop()!.unmount()
  captureEvent({ message: "root still active" })
  await getClient()?.flush(1000)
  expect(events()).toHaveLength(3)
})

test("captures uncaught errors and unhandled rejections with the SDK global handlers", async () => {
  initializeErrorReporting("web")
  globalThis.onerror?.call(window, "uncaught fixture", "https://app.example.com/assets/index.js?token=private#fragment", 10, 20, new Error("uncaught fixture"))
  globalThis.onunhandledrejection?.call(window, { reason: new Error("rejection fixture") } as PromiseRejectionEvent)
  await vi.waitFor(() => expect(events()).toHaveLength(2))
  expect(events().map(event => event.exception?.values?.[0]?.value)).toEqual(["uncaught fixture", "rejection fixture"])
  expect(events().every(event => event.exception?.values?.[0]?.mechanism?.handled === false)).toBe(true)
})

test("omits request, identity, breadcrumbs, arbitrary payloads and stack URL queries", async () => {
  initializeErrorReporting("web")
  captureEvent({
    exception: { values: [{ type: "Error", value: "diagnostic message", stacktrace: { frames: [
      { filename: "https://app.example.com/assets/app.js?token=private#private", lineno: 12 },
    ] } }] },
    request: { url: "https://app.example.com/auth/reset?token=private", headers: { Authorization: "private" } },
    user: { email: "private@example.com" },
    breadcrumbs: [{ message: "private" }],
    extra: { payload: "private" },
  })
  await getClient()?.flush(1000)
  expect(events()).toHaveLength(1)
  expect(events()[0]?.exception?.values?.[0]?.stacktrace?.frames?.[0]).toMatchObject({ filename: "https://app.example.com/assets/app.js", lineno: 12 })
  expect(JSON.stringify(events())).not.toContain("private")
  expect(getClient()?.getOptions().dataCollection?.userInfo).toBe(false)
})

test("uses the Vite environment default, keeps optional release unset and closes on shutdown", async () => {
  vi.stubEnv("VITE_SENTRY_ENVIRONMENT", " ")
  vi.stubEnv("VITE_SENTRY_RELEASE", "")
  initializeErrorReporting("web")
  expect(init).toHaveBeenCalledWith(expect.objectContaining({ environment: import.meta.env.MODE, release: undefined }))
  const app = createApp({ render: () => h("div", "usable") })
  installErrorReporting(app)
  apps.push(app)
  const element = document.createElement("div")
  app.mount(element)
  expect(element.textContent).toBe("usable")
  const previous = getClient()
  await shutdownErrorReporting()
  expect(previous?.getOptions().enabled).toBe(false)
  expect(transport.send).not.toHaveBeenCalled()
})
