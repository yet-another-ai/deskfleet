import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"
import { runInNewContext } from "node:vm"
import { beforeEach, expect, test, vi } from "vitest"
import type { Session, WebContentsViewConstructorOptions } from "electron"
import type { GoogleTagMessage } from "@deskfleet/client/google-tag"

const { fromPartition, createView } = vi.hoisted(() => ({ fromPartition: vi.fn(), createView: vi.fn() }))
vi.mock("electron", () => ({
  session: { fromPartition },
  WebContentsView: vi.fn(function (options: unknown) { return createView(options) }),
}))
import { DesktopGoogleTagHost } from "./google-tag-host.ts"

const script: GoogleTagMessage = { type: "loadScript", src: "https://www.googletagmanager.com/gtag/js?id=G-TEST" }
const event = (name: string): GoogleTagMessage => ({ type: "gtag", args: ["event", name, {}] })

function fixture(load = Promise.resolve()) {
  const target = Object.assign(new EventEmitter(), {
    protocol: { handle: vi.fn<Session["protocol"]["handle"]>(), unhandle: vi.fn() },
    webRequest: { onBeforeRequest: vi.fn<Session["webRequest"]["onBeforeRequest"]>() },
    setPermissionCheckHandler: vi.fn<Session["setPermissionCheckHandler"]>(),
    setPermissionRequestHandler: vi.fn<Session["setPermissionRequestHandler"]>(),
    fetch: vi.fn(async () => new Response("Google response")),
    clearStorageData: vi.fn(async () => {}),
    closeAllConnections: vi.fn(async () => {}),
  })
  const contents = Object.assign(new EventEmitter(), {
    loadURL: vi.fn(() => load),
    executeJavaScript: vi.fn(async (_source: string) => {}),
    setWindowOpenHandler: vi.fn(),
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
  })
  fromPartition.mockReturnValueOnce(target)
  createView.mockReturnValueOnce({ webContents: contents })
  return { target, contents }
}

beforeEach(() => vi.resetAllMocks())

test("waits for the first script and preserves queued command order", async () => {
  const { contents } = fixture()
  const host = new DesktopGoogleTagHost()
  const consent: GoogleTagMessage = { type: "gtag", args: ["consent", "update", { analytics_storage: "granted" }] }
  await host.send(consent)
  expect(createView).not.toHaveBeenCalled()

  const loading = host.send(script)
  const logging = host.send(event("app_opened"))
  await Promise.all([loading, logging])
  expect(contents.loadURL).toHaveBeenCalledExactlyOnceWith("https://desktop-telemetry.invalid/")
  expect(contents.executeJavaScript.mock.calls.map(([source]) => source)).toEqual(
    [consent, script, event("app_opened")].map(message => `window.__deskfleetGoogleTag(${JSON.stringify(message)})`),
  )
  const options = createView.mock.calls[0]![0] as WebContentsViewConstructorOptions
  expect(options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false })
  expect(options.webPreferences?.preload).toBeUndefined()
  expect(fromPartition.mock.calls[0]![0]).not.toMatch(/^persist:/)
  host.close()
})

test("revocation while loading discards old work and permits a clean re-enable", async () => {
  let finishLoad!: () => void
  const old = fixture(new Promise<void>(resolve => { finishLoad = resolve }))
  const host = new DesktopGoogleTagHost()
  await host.send(event("old_before_load"))
  const loading = host.send(script)
  const queued = host.send(event("old_after_load"))
  await host.send({ type: "reset" })
  expect(old.contents.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false })
  expect(old.target.clearStorageData).toHaveBeenCalledOnce()
  expect(old.target.closeAllConnections).toHaveBeenCalledOnce()

  const fresh = fixture()
  await host.send(script)
  await host.send(event("new_event"))
  finishLoad()
  await Promise.all([loading, queued])
  expect(old.contents.executeJavaScript).not.toHaveBeenCalled()
  expect(fresh.contents.executeJavaScript).toHaveBeenCalledTimes(2)
  expect(fromPartition.mock.calls[0]![0]).not.toBe(fromPartition.mock.calls[1]![0])
  host.close()
})

test("revocation during delivery prevents remaining commands from running", async () => {
  let finishDelivery!: () => void
  const { contents } = fixture()
  contents.executeJavaScript.mockImplementationOnce(() => new Promise(resolve => { finishDelivery = resolve }))
  const host = new DesktopGoogleTagHost()
  await host.send(event("first"))
  const sending = host.send(script)
  await vi.waitFor(() => expect(contents.executeJavaScript).toHaveBeenCalledOnce())
  host.close()
  finishDelivery()
  await sending
  expect(contents.executeJavaScript).toHaveBeenCalledOnce()
})

test("only the fixed local document and allowed Google HTTPS origins are reachable", async () => {
  const { target } = fixture()
  const host = new DesktopGoogleTagHost()
  await host.send(script)
  const handle = target.protocol.handle.mock.calls[0]![1]
  const filter = target.webRequest.onBeforeRequest.mock.calls[0]![0] as (details: { url: string }, callback: (result: { cancel?: boolean }) => void) => void
  const response = await handle(new Request("https://desktop-telemetry.invalid/"))
  expect(response.status).toBe(200)
  for (const url of ["http://www.google-analytics.com/g/collect", "https://desktop-telemetry.invalid/elsewhere", "https://example.test/", "file:///secret", "https://www.google-analytics.com.evil.test/g/collect"]) {
    const callback = vi.fn()
    filter({ url }, callback)
    expect(callback, url).toHaveBeenCalledExactlyOnceWith({ cancel: true })
  }
  const request = new Request("https://www.google-analytics.com/g/collect", { method: "POST", body: "event" })
  expect((await handle(request)).status).toBe(200)
  expect(target.fetch).toHaveBeenCalledExactlyOnceWith(request, { bypassCustomProtocolHandlers: true })
  expect((await handle(new Request("https://example.test/"))).status).toBe(403)
  expect((await handle(new Request("https://desktop-telemetry.invalid/", { method: "POST" }))).status).toBe(403)
  host.close()
  expect((await handle(request)).status).toBe(403)
  const callback = vi.fn()
  filter({ url: request.url }, callback)
  expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel: true })
})

test("rejects untrusted script sources before creating a view", async () => {
  const host = new DesktopGoogleTagHost()
  for (const src of ["https://example.test/a.js", "http://www.googletagmanager.com/gtag/js?id=G-TEST", "https://www.googletagmanager.com/other.js"]) {
    await expect(host.send({ type: "loadScript", src })).rejects.toThrow("not allowed")
  }
  expect(createView).not.toHaveBeenCalled()
})

test("rejects malformed messages and commands outside the telemetry contract", async () => {
  const host = new DesktopGoogleTagHost()
  for (const message of [null, { type: "script", source: "code" }, { type: "dataLayer", payload: [] }, { type: "gtag", args: "event" }, { type: "gtag", args: ["not_a_command"] }]) {
    await expect(host.send(message as GoogleTagMessage)).rejects.toThrow("not allowed")
  }
  expect(createView).not.toHaveBeenCalled()
})

test("isolated tag document denies permissions, windows, navigation and downloads", async () => {
  const { target, contents } = fixture()
  const host = new DesktopGoogleTagHost()
  await host.send(script)
  const check = target.setPermissionCheckHandler.mock.calls[0]![0]!
  expect(check(null, "media", "https://desktop-telemetry.invalid/", { isMainFrame: true })).toBe(false)
  const request = target.setPermissionRequestHandler.mock.calls[0]![0]!
  const callback = vi.fn()
  request(contents as never, "media", callback, { isMainFrame: true, requestingUrl: "https://desktop-telemetry.invalid/" })
  expect(callback).toHaveBeenCalledExactlyOnceWith(false)
  expect(contents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: "deny" })
  for (const name of ["will-navigate", "will-frame-navigate"]) {
    const navigation = { preventDefault: vi.fn() }
    contents.emit(name, navigation)
    expect(navigation.preventDefault).toHaveBeenCalledOnce()
  }
  const download = { preventDefault: vi.fn() }
  target.emit("will-download", download)
  expect(download.preventDefault).toHaveBeenCalledOnce()
  host.close()
})

test("bootstrap reconstructs Arguments and Date without executing event data", async () => {
  const { target, contents } = fixture()
  const host = new DesktopGoogleTagHost()
  await host.send(script)
  const response = await target.protocol.handle.mock.calls[0]![1](new Request("https://desktop-telemetry.invalid/"))
  const html = await response.text()
  const bootstrap = html.match(/<script>([\s\S]*)<\/script>/)![1]!
  expect(response.headers.get("content-security-policy")).toContain(`'sha256-${createHash("sha256").update(bootstrap).digest("base64")}'`)
  const appended: Array<{ src: string }> = []
  const context = { window: {} as Record<string, unknown>, document: { createElement: () => ({}), head: { appendChild: (element: { src: string }) => appended.push(element) } } }
  runInNewContext(bootstrap, context)
  contents.executeJavaScript.mockImplementation(async source => { runInNewContext(source, context) })
  const started = new Date("2026-11-17T12:00:00.000Z")
  await host.send({ type: "gtag", args: ["js", started] })
  await host.send(event("\"); window.injected = true; //"))
  await host.send(script)
  const entries = context.window.dataLayer as IArguments[]
  expect(Object.prototype.toString.call(entries[0])).toBe("[object Arguments]")
  expect(entries[0]?.[0]).toBe("consent")
  expect(entries[0]?.[2]).toMatchObject({ analytics_storage: "denied" })
  expect(Object.prototype.toString.call(entries[1]?.[1])).toBe("[object Date]")
  expect((entries[1]?.[1] as Date).toISOString()).toBe(started.toISOString())
  expect(entries[2]?.[1]).toBe("\"); window.injected = true; //")
  expect(context.window.injected).toBeUndefined()
  expect(appended).toEqual([{ async: true, src: script.src }])
  host.close()
})
