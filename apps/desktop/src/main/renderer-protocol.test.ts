import { join, resolve } from "node:path"
import type { Session, WebContents } from "electron"
import { expect, test, vi } from "vitest"
import { handleRendererProtocolRequest, installRendererPermissions, resolveRendererResourcePath } from "./renderer-protocol.ts"

// Outside Electron the package resolves to its executable path, not the API.
vi.mock("electron", () => ({ net: {}, protocol: {}, session: {} }))

const directory = resolve("/app/out/renderer")

test("renderer URLs map to files inside the bundle", () => {
  expect(resolveRendererResourcePath("deskfleet-app://bundle/index.html", directory)).toBe(
    join(directory, "index.html"),
  )
  expect(resolveRendererResourcePath("deskfleet-app://bundle/assets/a%20b.js?v=1", directory)).toBe(
    join(directory, "assets", "a b.js"),
  )
})

test("renderer URLs cannot escape the bundle", () => {
  for (const url of [
    "deskfleet-app://bundle/../secret",
    "deskfleet-app://bundle/%2e%2e/secret",
    "deskfleet-app://bundle/assets/..%2f..%2fsecret",
    "deskfleet-app://bundle/..%5csecret",
    "deskfleet-app://bundle/a%00b",
    "deskfleet-app://bundle/",
    "deskfleet-app://other/index.html",
    "file:///etc/passwd",
  ]) {
    expect(resolveRendererResourcePath(url, directory), url).toBeNull()
  }
})

test("only GET requests for bundled files are served", async () => {
  const fetchResource = vi.fn(async () => new Response("ok"))

  const post = { method: "POST", url: "deskfleet-app://bundle/index.html" }
  expect((await handleRendererProtocolRequest(post, fetchResource)).status).toBe(405)
  const escape = { method: "GET", url: "deskfleet-app://bundle/../x" }
  expect((await handleRendererProtocolRequest(escape, fetchResource)).status).toBe(400)
  expect(fetchResource).not.toHaveBeenCalled()

  const missing = vi.fn(async () => new Response(null, { status: 500 }))
  const index = { method: "GET", url: "deskfleet-app://bundle/index.html" }
  expect((await handleRendererProtocolRequest(index, missing)).status).toBe(404)
})

function permissionHandlers() {
  const target = {
    setPermissionCheckHandler: vi.fn<Session["setPermissionCheckHandler"]>(),
    setPermissionRequestHandler: vi.fn<Session["setPermissionRequestHandler"]>(),
  }
  installRendererPermissions(target)
  return {
    check: target.setPermissionCheckHandler.mock.calls[0]![0]!,
    request: target.setPermissionRequestHandler.mock.calls[0]![0]!,
  }
}

test.each(["deskfleet-app://bundle/index.html#/sessions/one", "http://127.0.0.1:5173/#/desktop"])(
  "copy and fullscreen are allowed for the main renderer at %s",
  url => {
    const { check, request } = permissionHandlers()
    const webContents = { getURL: () => url } as WebContents
    const details = { isMainFrame: true, requestingUrl: url }
    for (const permission of ["clipboard-sanitized-write", "fullscreen"] as const) {
      expect(check(webContents, permission, new URL(url).origin, details)).toBe(true)
      const callback = vi.fn()
      request(webContents, permission, callback, details)
      expect(callback).toHaveBeenCalledExactlyOnceWith(true)
    }
  },
)

test("clipboard reads, automatic fullscreen, and unrelated capabilities remain denied", () => {
  const { check, request } = permissionHandlers()
  const url = "deskfleet-app://bundle/index.html"
  const webContents = { getURL: () => url } as WebContents
  const details = { isMainFrame: true, requestingUrl: url }
  for (const permission of ["clipboard-read", "deprecated-sync-clipboard-read", "automatic-fullscreen", "media", "display-capture", "notifications"] as const) {
    expect(check(webContents, permission, "deskfleet-app://bundle/", details)).toBe(false)
    const callback = vi.fn()
    request(webContents, permission, callback, details)
    expect(callback).toHaveBeenCalledExactlyOnceWith(false)
  }
})

test("copy and fullscreen stay denied for subframes and other documents", () => {
  const { check, request } = permissionHandlers()
  const main = "deskfleet-app://bundle/index.html"
  for (const [topUrl, requestingUrl, isMainFrame] of [
    [main, main, false],
    [main, "deskfleet-app://bundle/other.html", true],
    [main, "https://example.com/", true],
    [main, "", true],
    ["https://example.com/", main, true],
  ] as const) {
    const webContents = { getURL: () => topUrl } as WebContents
    const details = { isMainFrame, requestingUrl }
    for (const permission of ["clipboard-sanitized-write", "fullscreen"] as const) {
      expect(check(webContents, permission, "deskfleet-app://bundle/", details)).toBe(false)
      const callback = vi.fn()
      request(webContents, permission, callback, details)
      expect(callback).toHaveBeenCalledExactlyOnceWith(false)
    }
  }
  expect(check(null, "clipboard-sanitized-write", "deskfleet-app://bundle/", { isMainFrame: true, requestingUrl: main })).toBe(false)
})
