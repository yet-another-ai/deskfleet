import { createApp, h } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { captureEvent, getClient, init, type ErrorEvent } from "@sentry/vue"
import type { AccountState, CentralApi } from "@deskfleet/client/central"
import { centralRequestFailure } from "@deskfleet/client/request-diagnostics"
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
    method: "POST", path: "/api/teams/private-team/machines/private-machine/rpc?token=private-query", elapsedMs: 123.4,
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
  await getClient()?.flush(1000)
  expect(events()[0]?.contexts).toMatchObject({
    os: { name: "macOS", version: "15.6" }, device: { arch: "arm64" }, app: { app_version: "0.2.2" },
    runtime: { name: "Electron", version: "45.0.0" }, node: { name: "Node.js", version: "24.0.0" },
    browser: { name: "Chrome", version: "152.0.0.0" },
  })
})

test("reports handled central transport failures with bounded diagnostics and deduplicates the same rejection", async () => {
  initializeErrorReporting("desktop")
  setErrorReportingUser({ id: "user-1", email: "ada@example.test" })
  const error = requestFailure()
  captureCentralRequestError(error)
  await getClient()?.flush(1000)
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
    "central-request", "node_fetch", "POST", "/api/teams/:teamId/machines/:machineId/rpc", method, code,
  ]))
})

test("groups the same operation across generated platform stacks while retaining each stack", async () => {
  initializeErrorReporting("desktop")
  for (const bundle of ["client-macos", "client-windows"]) {
    const error = requestFailure()
    error.stack = `TypeError: fetch failed\n    at HttpCentralClient.request (app:///${bundle}.js:10:20)`
    captureCentralRequestError(error)
    await getClient()?.flush(1000)
  }
  expect(events()).toHaveLength(2)
  expect(events()[0]?.fingerprint).toEqual(events()[1]?.fingerprint)
  expect(events().map(event => event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename))
    .toEqual(["app:///client-macos.js", "app:///client-windows.js"])
})

test("enriches an unhandled central rejection with the same operation identity", async () => {
  initializeErrorReporting("web")
  globalThis.onunhandledrejection?.call(window, { reason: requestFailure() } as PromiseRejectionEvent)
  await getClient()?.flush(1000)
  expect(events()[0]?.fingerprint).toEqual([
    "central-request", "browser_fetch", "POST", "/api/teams/:teamId/machines/:machineId/rpc", "_deskfleet/agent/configuration", "ENOTFOUND",
  ])
  expect(events()[0]?.exception?.values?.[0]?.type).toBe("CentralRequestError")
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
  await getClient()?.flush(1000)
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
  await getClient()?.flush(1000)
  expect(events()).toHaveLength(0)

  const messages = [
    "[VueUse] Failed to find the definition of reusable template",
    "Failed to fetch dynamically imported module: https://app.example.com/assets/SettingsView.js",
    "ResizeObserver callback failed while updating the terminal",
  ]
  for (const message of messages) {
    globalThis.onerror?.call(window, message, "https://app.example.com/assets/index.js", 10, 20, new Error(message))
  }
  await getClient()?.flush(1000)
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
  await getClient()?.flush(1000)
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
