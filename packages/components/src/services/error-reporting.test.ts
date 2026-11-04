import { createApp, h } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { captureEvent, getClient, init, type ErrorEvent } from "@sentry/vue"
import type { AccountState, CentralApi } from "@deskfleet/client/central"
import { centralRequestFailure } from "@deskfleet/client/request-diagnostics"
import { browserClient } from "@deskfleet/client/browser"
import { withCentralRequestTrigger } from "@deskfleet/client/reporting-central"
import type { HttpCentralClient } from "@deskfleet/client/http-central"
import { captureCentralRequestError, initializeErrorReporting, installErrorReporting, installErrorReportingAccount, setErrorReportingUser, shutdownErrorReporting } from "./error-reporting.ts"

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
  vi.stubEnv("VITE_SENTRY_DIST", " macos-arm64 ")
})
afterEach(async () => {
  for (const app of apps.splice(0)) app.unmount()
  vi.useRealTimers()
  await shutdownErrorReporting()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function flushSdk(): Promise<void> {
  const pending = getClient()?.flush(1000)
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(10)
  await pending
}

function events(): ErrorEvent[] {
  return transport.send.mock.calls.flatMap(([envelope]) => envelope[1]
    .filter(([header]) => header.type === "event").map(([, event]) => event as ErrorEvent))
}

function requestFailure(rpcMethod = "_deskfleet/agent/configuration", code = "ENOTFOUND", requestTransport: "node_fetch" | "browser_fetch" = "node_fetch") {
  return centralRequestFailure(new TypeError("fetch failed", {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND private-host"), { code }),
  }), {
    method: "POST", path: "/api/teams/private-team/machines/private-machine/rpc?token=private-query", elapsedMs: 123.4,
    transport: requestTransport,
    body: { method: rpcMethod, params: { provider: "private-provider", workspaceId: "private-workspace" } },
  }, "Error\n    at loadConfiguration (app:///client.js:10:20)")
}

test.each([undefined, "", "  ", "invalid", "https://sentry.example.com/42"])("does not initialize or change Vue handlers with DSN %s", dsn => {
  vi.stubEnv("VITE_SENTRY_DSN", dsn)
  const app = createApp({ render: () => null })
  const handler = vi.fn()
  app.config.errorHandler = handler
  initializeErrorReporting("web")
  setErrorReportingUser({ id: "user-1", email: "ada@example.test" })
  captureCentralRequestError(requestFailure())
  installErrorReporting(app)
  const central = { status: vi.fn(), onEvent: vi.fn() }
  installErrorReportingAccount(app, central)
  expect(central.status).not.toHaveBeenCalled()
  expect(central.onEvent).not.toHaveBeenCalled()
  expect(init).not.toHaveBeenCalled()
  expect(transport.send).not.toHaveBeenCalled()
  expect(app.config.errorHandler).toBe(handler)
})

test.each(["web", "desktop"] as const)("%s reports follow the authenticated ID and email through account changes and sign-out", async platform => {
  initializeErrorReporting(platform)
  captureEvent({ message: "before sign-in" })
  setErrorReportingUser({ id: "user-1", email: "ada@example.test" })
  captureEvent({ message: "signed in" })
  setErrorReportingUser({ id: "user-1", email: "new@example.test" })
  captureEvent({ message: "email changed" })
  setErrorReportingUser({ id: "user-2", email: null })
  captureEvent({ message: "another account without email" })
  setErrorReportingUser()
  captureEvent({ message: "signed out" })
  await getClient()?.flush(1000)
  expect(events().map(event => event.user)).toEqual([
    undefined,
    { id: "user-1", email: "ada@example.test" },
    { id: "user-1", email: "new@example.test" },
    { id: "user-2" },
    undefined,
  ])
})

test("standalone previews refresh identity and ignore account responses superseded by sign-out or teardown", async () => {
  initializeErrorReporting("desktop")
  const app = createApp({ render: () => null })
  let account: AccountState = { serverUrl: "https://fleet.example", siteAdmin: false, user: { id: "user-1", name: "Ada", email: "ada@example.test" } }
  let notify!: Parameters<CentralApi["onEvent"]>[0]
  const stop = vi.fn()
  const central = {
    status: vi.fn(async () => account),
    onEvent: (listener: typeof notify) => { notify = listener; return stop },
  }
  installErrorReportingAccount(app, central)
  apps.push(app)
  app.mount(document.createElement("div"))
  await Promise.resolve()
  captureEvent({ message: "preview signed in" })

  account = { ...account, user: { ...account.user!, email: "new@example.test" } }
  notify({ type: "connection", connected: true })
  await Promise.resolve()
  captureEvent({ message: "preview email refreshed" })

  const pending = Promise.withResolvers<AccountState>()
  central.status.mockReturnValueOnce(pending.promise)
  notify({ type: "accountChanged" })
  account = { serverUrl: account.serverUrl, siteAdmin: false }
  notify({ type: "accountChanged" })
  await Promise.resolve()
  pending.resolve({ ...account, user: { id: "old-account", name: "Old" } })
  await Promise.resolve()
  captureEvent({ message: "preview signed out" })

  const late = Promise.withResolvers<AccountState>()
  central.status.mockReturnValueOnce(late.promise)
  notify({ type: "accountChanged" })
  apps.pop()!.unmount()
  expect(stop).toHaveBeenCalledTimes(1)
  late.resolve({ ...account, user: { id: "late-account", name: "Late" } })
  await Promise.resolve()
  captureEvent({ message: "preview disposed" })
  await getClient()?.flush(1000)
  expect(events().map(event => event.user)).toEqual([
    { id: "user-1", email: "ada@example.test" },
    { id: "user-1", email: "new@example.test" },
    undefined,
    undefined,
  ])
})

test("reports desktop OS and runtime versions for errors without a machine identity", async () => {
  initializeErrorReporting("desktop", {
    os: { name: "macOS", version: "15.6" }, architecture: "arm64", appVersion: "0.2.2",
    electronVersion: "45.0.0", nodeVersion: "24.0.0", chromeVersion: "152.0.0.0",
  })
  captureEvent({ message: "desktop failure" })
  await flushSdk()
  expect(events()[0]?.contexts).toMatchObject({
    os: { name: "macOS", version: "15.6" }, device: { arch: "arm64" }, app: { app_version: "0.2.2" },
    runtime: { name: "Electron", version: "45.0.0" }, node: { name: "Node.js", version: "24.0.0" },
    browser: { name: "Chrome", version: "152.0.0.0" },
  })
  expect(events()[0]?.dist).toBe("macos-arm64")
})

test("reports handled central transport failures with bounded diagnostics and deduplicates the same rejection", async () => {
  initializeErrorReporting("desktop")
  setErrorReportingUser({ id: "user-1", email: "ada@example.test" })
  const error = requestFailure()
  captureCentralRequestError(error)
  await flushSdk()
  expect(events()).toHaveLength(1)
  expect(events()[0]).toMatchObject({
    user: { id: "user-1", email: "ada@example.test" },
    exception: { values: [{ type: "CentralRequestError", value: "POST /api/teams/:teamId/machines/:machineId/rpc (_deskfleet/agent/configuration) — ENOTFOUND" }] },
    tags: { platform: "desktop", "central.method": "POST", "central.route": "/api/teams/:teamId/machines/:machineId/rpc", "central.rpc_method": "_deskfleet/agent/configuration", "central.cause_code": "ENOTFOUND" },
    contexts: { central_request: {
      method: "POST", route: "/api/teams/:teamId/machines/:machineId/rpc", rpc_method: "_deskfleet/agent/configuration", elapsed_ms: 123,
      causes: ["TypeError", "Error: ENOTFOUND"],
    } },
  })
  expect(events()[0]?.exception?.values?.[0]?.stacktrace?.frames?.length).toBeGreaterThan(0)
  expect(error.message).toBe("fetch failed")
  expect(JSON.stringify(events())).not.toContain("private")
  globalThis.onunhandledrejection?.call(window, { reason: error } as PromiseRejectionEvent)
  await flushSdk()
  expect(events()).toHaveLength(1)
})

test("leaves ordinary errors to their existing handlers", async () => {
  initializeErrorReporting("desktop")
  captureCentralRequestError(new Error("Provider rejected the model"))
  await flushSdk()
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
    await flushSdk()
  }
  expect(events()).toHaveLength(3)
  expect(events().map(event => event.fingerprint)).toEqual(requests.map(([method, code]) => [
    "central-request", "node_fetch", "POST", "/api/teams/:teamId/machines/:machineId/rpc", method, code === "ETIMEDOUT" ? "timeout" : "network", "fetch", code,
  ]))
})

test("groups the same operation across generated platform stacks while retaining each stack", async () => {
  initializeErrorReporting("desktop")
  for (const bundle of ["client-macos", "client-windows"]) {
    const error = requestFailure()
    error.stack = `TypeError: fetch failed\n    at HttpCentralClient.request (app:///${bundle}.js:10:20)`
    captureCentralRequestError(error)
    await flushSdk()
  }
  expect(events()).toHaveLength(2)
  expect(events()[0]?.fingerprint).toEqual(events()[1]?.fingerprint)
  expect(events().map(event => event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename))
    .toEqual(["app:///client-macos.js", "app:///client-windows.js"])
})

test("enriches an unhandled central rejection with the same operation identity", async () => {
  initializeErrorReporting("web")
  globalThis.onunhandledrejection?.call(window, { reason: requestFailure(undefined, undefined, "browser_fetch") } as PromiseRejectionEvent)
  await flushSdk()
  expect(events()[0]?.fingerprint).toEqual([
    "central-request", "browser_fetch", "POST", "/api/teams/:teamId/machines/:machineId/rpc", "_deskfleet/agent/configuration", "network", "fetch", "ENOTFOUND",
  ])
  expect(events()[0]?.exception?.values?.[0]?.type).toBe("CentralRequestError")
})

test("the Web adapter reports handled HTTP and decoding failures with bounded diagnostics", async () => {
  initializeErrorReporting("web")
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "private-code", message: "private-response" } }), { status: 503 }))
    .mockResolvedValueOnce(new Response("<html>private-response</html>"))
  vi.stubGlobal("fetch", fetch)
  const adapter = await browserClient("https://fleet.example", captureCentralRequestError)
  try {
    await adapter.central!.teams().catch(() => {})
    await adapter.central!.teams().catch(() => {})
    await flushSdk()
    expect(events()).toHaveLength(2)
    expect(events().map(event => event.exception?.values?.[0]?.value)).toEqual(["GET /api/teams — HTTP 503", "GET /api/teams — decode"])
    expect(events()[0]?.contexts?.central_request).toMatchObject({ transport: "browser_fetch", kind: "http", status: 503 })
    expect(events()[1]?.contexts?.central_request).toMatchObject({ kind: "decode", phase: "response_body", status: 200 })
    for (const secret of ["private-response", "private-code", "fleet.example"]) expect(JSON.stringify(events())).not.toContain(secret)
  } finally { (adapter.central as HttpCentralClient).dispose() }
})

test("caller cancellation is ignored while deadlines still report a timeout", async () => {
  initializeErrorReporting("web")
  for (const name of ["AbortError", "TimeoutError"]) {
    const controller = new AbortController()
    controller.abort(new DOMException("stopped", name))
    const error = centralRequestFailure(controller.signal.reason, { method: "GET", path: "/api/me", elapsedMs: 10, signal: controller.signal })
    captureCentralRequestError(error)
    globalThis.onunhandledrejection?.call(window, { reason: error } as PromiseRejectionEvent)
  }
  await flushSdk()
  expect(events()).toHaveLength(1)
  expect(events()[0]?.tags?.["central.failure_kind"]).toBe("timeout")
})

test("background summaries reach the real SDK and user requests keep every occurrence", async () => {
  vi.useFakeTimers()
  initializeErrorReporting("web")
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => { throw new TypeError("Failed to fetch") }))
  const adapter = await browserClient("https://fleet.example", captureCentralRequestError)
  const automatic = withCentralRequestTrigger(adapter.central!, "background")
  const user = withCentralRequestTrigger(automatic, "user")
  try {
    for (let index = 0; index < 3; index++) await automatic.teams().catch(() => {})
    await flushSdk()
    expect(events()).toHaveLength(1)
    expect(events()[0]?.contexts?.central_request).toMatchObject({ trigger: "background", online: false, visibility: "hidden" })
    expect(events()[0]?.level).toBe("warning")
    await vi.advanceTimersByTimeAsync(60_000)
    await flushSdk()
    expect(events()).toHaveLength(2)
    expect(events()[1]?.contexts?.request_repetition).toEqual({ occurrences: 2, window_ms: 60_000, summary: true })
    expect(events()[1]?.fingerprint).toEqual(events()[0]?.fingerprint)
    for (let index = 0; index < 2; index++) await user.teams().catch(() => {})
    await flushSdk()
    expect(events().filter(event => event.tags?.["central.trigger"] === "user")).toHaveLength(2)
  } finally { (adapter.central as HttpCentralClient).dispose() }
})

test("hidden background network failures do not hide visible, user, or HTTP failures", async () => {
  vi.useFakeTimers()
  initializeErrorReporting("web")
  const capture = (trigger: "background" | "user" | "unknown", visibility: "visible" | "hidden", kind: "network" | "timeout" | "http") => {
    const error = requestFailure()
    Object.assign(error.diagnostics, { trigger, visibility, kind, ...(kind === "http" ? { status: 503 } : {}) })
    captureCentralRequestError(error)
  }
  capture("background", "hidden", "network")
  capture("background", "hidden", "network")
  capture("background", "visible", "network")
  capture("background", "visible", "network")
  capture("background", "hidden", "timeout")
  capture("background", "hidden", "http")
  capture("user", "hidden", "network")
  capture("unknown", "hidden", "network")
  await vi.advanceTimersByTimeAsync(60_000)
  await flushSdk()
  const reports = events()
  expect(reports.filter(event => event.level === "warning")).toHaveLength(3)
  expect(reports.filter(event => event.level === "error")).toHaveLength(5)
  expect(reports.filter(event => event.tags?.["central.report_type"] === "summary")
    .map(event => [event.tags?.["central.visibility"], event.level])).toEqual([["hidden", "warning"], ["visible", "error"]])
})

test.each(["pagehide", "shutdown"])("flushes background occurrence counts on %s", async lifecycle => {
  vi.useFakeTimers()
  initializeErrorReporting("desktop")
  for (let index = 0; index < 3; index++) {
    const error = requestFailure()
    error.diagnostics.trigger = "background"
    captureCentralRequestError(error)
  }
  if (lifecycle === "pagehide") window.dispatchEvent(new Event("pagehide"))
  else {
    const closing = shutdownErrorReporting()
    await vi.advanceTimersByTimeAsync(10)
    await closing
  }
  await flushSdk()
  expect(events().map(event => event.contexts?.request_repetition?.occurrences)).toEqual([1, 2])
})

test("background summaries stay with their original account across identity changes", async () => {
  initializeErrorReporting("web")
  setErrorReportingUser({ id: "first", email: "first@example.test" })
  for (let index = 0; index < 3; index++) {
    const error = requestFailure()
    error.diagnostics.trigger = "background"
    captureCentralRequestError(error)
  }
  setErrorReportingUser({ id: "second", email: "second@example.test" })
  const error = requestFailure()
  error.diagnostics.trigger = "background"
  captureCentralRequestError(error)
  await flushSdk()
  expect(events().map(event => [event.user?.id, event.contexts?.request_repetition?.occurrences])).toEqual([
    ["first", 1], ["first", 2], ["second", 1],
  ])
})

test("captures real Vue errors from multiple apps through one client without props", async () => {
  initializeErrorReporting("desktop")
  initializeErrorReporting("desktop")
  setErrorReportingUser({ id: "user-1", email: "ada@example.test" })
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
    expect(event.user).toEqual({ id: "user-1", email: "ada@example.test" })
    expect(event).toMatchObject({ environment: "staging", release: "deskfleet@0.2.1", tags: { platform: "desktop" } })
    expect(event.contexts?.vue).toBeDefined()
  }
  expect(JSON.stringify(events())).not.toContain("private-prop")
  // Unmounting a machine surface must not close the document's client.
  apps.pop()!.unmount()
  captureEvent({ message: "root still active" })
  await flushSdk()
  expect(events()).toHaveLength(3)
  expect(events()[2]?.user).toEqual({ id: "user-1", email: "ada@example.test" })
})

test("captures uncaught errors and unhandled rejections with the SDK global handlers", async () => {
  initializeErrorReporting("web")
  globalThis.onerror?.call(window, "uncaught fixture", "https://app.example.com/assets/index.js?token=private#fragment", 10, 20, new Error("uncaught fixture"))
  globalThis.onunhandledrejection?.call(window, { reason: new Error("rejection fixture") } as PromiseRejectionEvent)
  await vi.waitFor(() => expect(events()).toHaveLength(2))
  expect(events().map(event => event.exception?.values?.[0]?.value)).toEqual(["uncaught fixture", "rejection fixture"])
  expect(events().every(event => event.exception?.values?.[0]?.mechanism?.handled === false)).toBe(true)
})

test.each(["web", "desktop"] as const)("filters browser noise while retaining application failures on %s", async platform => {
  initializeErrorReporting(platform)
  for (const message of ["Script error.", "ResizeObserver loop completed with undelivered notifications."]) {
    globalThis.onerror?.call(window, message, "", 0, 0)
  }
  await flushSdk()
  expect(events()).toHaveLength(0)

  const messages = [
    "[VueUse] Failed to find the definition of reusable template",
    "Failed to fetch dynamically imported module: https://app.example.com/assets/SettingsView.js",
    "ResizeObserver callback failed while updating the terminal",
  ]
  for (const message of messages) {
    globalThis.onerror?.call(window, message, "https://app.example.com/assets/index.js", 10, 20, new Error(message))
  }
  await flushSdk()
  expect(events().map(event => event.exception?.values?.[0]?.value)).toEqual(messages)
})

test("retains only user ID and email while omitting request data, breadcrumbs, payloads and stack URL queries", async () => {
  initializeErrorReporting("web")
  captureEvent({
    exception: { values: [{ type: "Error", value: "diagnostic message", stacktrace: { frames: [
      { filename: "https://app.example.com/assets/app.js?token=private#private", lineno: 12 },
    ] } }] },
    request: { url: "https://app.example.com/auth/reset?token=private", headers: { Authorization: "private" } },
    user: { id: "user-1", email: "ada@example.test", username: "private", ip_address: "private", data: { secret: "private" } },
    breadcrumbs: [{ message: "private" }],
    extra: { payload: "private" },
  })
  await flushSdk()
  expect(events()).toHaveLength(1)
  expect(events()[0]?.user).toEqual({ id: "user-1", email: "ada@example.test" })
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
  setErrorReportingUser({ id: "user-1", email: "ada@example.test" })
  await shutdownErrorReporting()
  expect(previous?.getOptions().enabled).toBe(false)
  expect(transport.send).not.toHaveBeenCalled()
  initializeErrorReporting("web")
  captureEvent({ message: "fresh document" })
  await getClient()?.flush(1000)
  expect(events()[0]?.user).toBeUndefined()
})
