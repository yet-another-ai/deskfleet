import { afterEach, expect, test, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HttpCentralClient } from "@deskfleet/client/http-central"
import { observePeerGrant, setPeerTelemetrySink } from "@deskfleet/client/peer-telemetry"
import { centralBridgeClient, type CentralBridge, type CentralIpcResult } from "@deskfleet/client/central-bridge"
import { CentralRequestError } from "@deskfleet/client/request-diagnostics"

vi.mock("electron", () => ({
  app: { getPath: vi.fn(), once: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
  safeStorage: { isAsyncEncryptionAvailable: vi.fn(), decryptStringAsync: vi.fn(), encryptStringAsync: vi.fn() },
  shell: { openExternal: vi.fn() },
}))
vi.mock("./desktop-media.ts", () => ({ isDesktopMediaSender: () => true }))
vi.mock("./daemon-client.ts", () => ({ DaemonClient: { connect: vi.fn() } }))
vi.mock("./backend.ts", () => ({ backendUrl: "https://fleet.example/" }))
import { app, BrowserWindow, ipcMain, safeStorage } from "electron"
import { CENTRAL_CHANNEL, CENTRAL_EVENT, installCentralAccount } from "./central-account.ts"

const user = { id: "user-1", name: "Ada" }
const serverUrl = "https://fleet.example"
const roots: string[] = []
const clients: HttpCentralClient[] = []
const networkFetch = globalThis.fetch
function sentRequest(fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>, index = -1): Request {
  const input = fetch.mock.calls.at(index)?.[0]
  expect(input).toBeInstanceOf(Request)
  return input as Request
}
afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose()
  setPeerTelemetrySink(undefined)
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

test("main-process peer telemetry reaches the renderer without peer credentials", async () => {
  const f = await setup(), send = vi.fn(), destroyedSend = vi.fn()
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
    { isDestroyed: () => false, webContents: { send } },
    { isDestroyed: () => true, webContents: { send: destroyedSend } },
  ] as unknown as Electron.BrowserWindow[])
  await f.install()
  const telemetry = observePeerGrant("ports", { iceServers: [{ urls: "turn:private.example", username: "private-user", credential: "secret" }] }, "team")
  telemetry.connected()
  expect(send.mock.calls).toEqual([
    [CENTRAL_EVENT, { type: "peerTelemetry", event: { name: "peer_granted", teamId: "team", metadata: { feature: "ports", relay: "allowed" } } }],
    [CENTRAL_EVENT, { type: "peerTelemetry", event: { name: "peer_connection", teamId: "team", metadata: { feature: "ports", relay: "allowed", outcome: "connected", transport: "unknown" } } }],
  ])
  expect(destroyedSend).not.toHaveBeenCalled()
  const quitting = vi.mocked(app.once).mock.calls.find(([name]) => String(name) === "will-quit")![1]
  quitting()
  observePeerGrant("files", { iceServers: [] }, "team")
  expect(send).toHaveBeenCalledTimes(2)
})

async function setup(stored: Record<string, unknown> = {}) {
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([])
  const root = await mkdtemp(join(tmpdir(), "deskfleet-account-"))
  roots.push(root)
  const path = join(root, "account.json")
  await writeFile(path, JSON.stringify({ serverUrl, ...stored }))
  vi.mocked(app.getPath).mockReturnValue(root)
  vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true)
  vi.mocked(safeStorage.decryptStringAsync).mockResolvedValue({ result: "restored-token", shouldReEncrypt: false })
  vi.mocked(safeStorage.encryptStringAsync).mockResolvedValue(Buffer.from("encrypted-new-token"))
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ token: "new-token", user })))
  vi.stubGlobal("fetch", fetch)
  vi.stubGlobal("WebSocket", class { close() {} })
  return { path, fetch, install: async () => {
    const client = await installCentralAccount()
    clients.push(client)
    return client
  } }
}

test("restores an encrypted account using the async decryption result", async () => {
  const encrypted = Buffer.from("saved-encrypted-token")
  const f = await setup({ encryptedToken: encrypted.toString("base64"), user })
  const client = await f.install()
  expect(await client.status()).toEqual({ serverUrl, user, siteAdmin: false })
  expect(safeStorage.decryptStringAsync).toHaveBeenCalledExactlyOnceWith(encrypted)
  expect(sentRequest(f.fetch).url).toBe(`${serverUrl}/api/me`)
  expect(sentRequest(f.fetch).headers.get("authorization")).toBe("Bearer restored-token")
})

test("the desktop account bridge forwards ownership transfer to the selected Team", async () => {
  const f = await setup({ encryptedToken: Buffer.from("saved-token").toString("base64"), user })
  await f.install()
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === CENTRAL_CHANNEL)![1]
  let submitted: unknown
  f.fetch.mockImplementationOnce(async input => { submitted = await (input as Request).json(); return Response.json({}) })
  await handler({} as Electron.IpcMainInvokeEvent, "transferOwnership", ["team/1", "user-2"])
  expect(sentRequest(f.fetch)).toMatchObject({ url: `${serverUrl}/api/teams/team%2F1/ownership`, method: "POST" })
  expect(submitted).toEqual({ userId: "user-2" })
})

test("a fresh profile uses the compiled backend without account configuration", async () => {
  const f = await setup()
  await rm(f.path)
  const client = await f.install()
  expect(await client.status()).toEqual({ serverUrl, user: undefined, siteAdmin: false })
  expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled()
})

test("a saved backend cannot override the compiled address or supply its credentials", async () => {
  const f = await setup({ serverUrl: "https://old.example", encryptedToken: Buffer.from("old-token").toString("base64"), user })
  const client = await f.install()
  expect(await client.status()).toEqual({ serverUrl, user: undefined, siteAdmin: false })
  expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled()
  await client.site()
  expect(f.fetch).toHaveBeenCalledOnce()
  expect(sentRequest(f.fetch).url).toBe(`${serverUrl}/api/site`)
  expect(sentRequest(f.fetch).headers.has("authorization")).toBe(false)
})

test("desktop IPC reads public site settings but rejects administration even for a site administrator", async () => {
  const f = await setup({ encryptedToken: Buffer.from("saved-token").toString("base64"), user })
  const client = await f.install()
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ user, siteAdmin: true })))
  expect((await client.status()).siteAdmin).toBe(true)
  f.fetch.mockClear()

  const settings = { siteName: "Studio fleet", announcement: "News", allowTeamCreation: false, termsOfServiceUrl: "https://example.test/terms", privacyTermsUrl: "https://example.test/privacy" }
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify(settings)))
  const invoke = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === CENTRAL_CHANNEL)![1]
  const event = {} as Electron.IpcMainInvokeEvent
  await expect(invoke(event, "site", [])).resolves.toEqual({ ok: true, value: settings })
  await expect(invoke(event, "siteSettings", [])).rejects.toThrow("Invalid account operation")
  await expect(invoke(event, "setServer", ["https://other.example"])).rejects.toThrow("Invalid account operation")
  await expect(invoke(event, "updateSiteSettings", [settings])).rejects.toThrow("Invalid account operation")
  expect(f.fetch).toHaveBeenCalledOnce()
  expect(sentRequest(f.fetch)).toMatchObject({ url: `${serverUrl}/api/site`, method: "GET" })
})

test("login waits for async encryption before saving the token and publishing the account", async () => {
  const f = await setup()
  const client = await f.install()
  const changed = vi.fn()
  client.onEvent(changed)
  let complete!: (encrypted: Buffer) => void
  vi.mocked(safeStorage.encryptStringAsync).mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  const exchange = client.exchange("callback-code", "verifier")
  await vi.waitFor(() => expect(safeStorage.encryptStringAsync).toHaveBeenCalledWith("new-token"))
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ serverUrl })
  expect(changed).not.toHaveBeenCalled()
  const encrypted = Buffer.from("encrypted-new-token")
  complete(encrypted)
  await exchange
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ serverUrl, encryptedToken: encrypted.toString("base64"), user })
  expect(changed).toHaveBeenCalledExactlyOnceWith({ type: "accountChanged" })
})

test("unavailable encryption neither restores nor persists credentials", async () => {
  const f = await setup({ encryptedToken: Buffer.from("saved-encrypted-token").toString("base64"), user })
  vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false)
  const client = await f.install()
  expect(await client.status()).toEqual({ serverUrl, user: undefined, siteAdmin: false })
  expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled()
  await client.exchange("callback-code", "verifier")
  expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled()
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ serverUrl })
})

test("an async encryption failure preserves the saved account and rejects login", async () => {
  const f = await setup({ encryptedToken: Buffer.from("saved-encrypted-token").toString("base64"), user })
  const saved = await readFile(f.path, "utf8")
  const client = await f.install()
  vi.mocked(safeStorage.encryptStringAsync).mockRejectedValueOnce(new Error("Keychain unavailable"))
  await expect(client.exchange("callback-code", "verifier")).rejects.toThrow("Keychain unavailable")
  expect(await readFile(f.path, "utf8")).toBe(saved)
})

test("desktop GitHub settings bridge keeps authorization in the host transport", async () => {
  const f = await setup({ encryptedToken: Buffer.from("saved-token").toString("base64"), user })
  await f.install()
  const invoke = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === CENTRAL_CHANNEL)![1]
  const settings = { configured: true, manageUrl: "https://github.com/apps/deskfleet/installations/new", authorized: true, login: "octocat", actAsYou: false }
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify(settings)))
  await expect(invoke({} as Electron.IpcMainInvokeEvent, "githubSettings", [])).resolves.toEqual({ ok: true, value: settings })
  let submitted: unknown
  f.fetch.mockImplementationOnce(async input => { submitted = await (input as Request).json(); return Response.json({ ...settings, actAsYou: true }) })
  await invoke({} as Electron.IpcMainInvokeEvent, "setGithubActAsYou", [true])
  expect(sentRequest(f.fetch)).toMatchObject({ url: `${serverUrl}/api/integrations/github`, method: "PATCH" })
  expect(submitted).toEqual({ actAsYou: true })
  const pullRequest = { number: 78, title: "Show PR status", url: "https://github.com/owner/repo/pull/78", state: "draft" }
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ pullRequest })))
  await expect(invoke({} as Electron.IpcMainInvokeEvent, "githubPullRequest", [{ owner: "owner", repo: "repo", branch: "feat/status" }])).resolves.toEqual({ ok: true, value: { pullRequest } })
  expect(sentRequest(f.fetch)).toMatchObject({ url: `${serverUrl}/api/integrations/github/pull-request?owner=owner&repo=repo&branch=feat%2Fstatus`, method: "GET" })
})

test("the browser login callback submits its code as a same-origin form", async () => {
  const f = await setup()
  const loginCode = "one-use+code&value"
  let returnTo = ""
  f.fetch.mockImplementation(async input => {
    expect(input).toBeInstanceOf(Request)
    const request = input as Request
    const body = await request.json()
    if (request.url.endsWith("/api/auth/start")) {
      returnTo = body.returnTo
      return Response.json({ authorizationUrl: "https://fleet.example/auth/authorize", loginVerifier: "private-verifier" })
    }
    expect(request.url).toBe(`${serverUrl}/api/auth/exchange`)
    expect(body).toEqual({ code: loginCode, loginVerifier: "private-verifier" })
    return Response.json({ token: "new-token", user })
  })
  const client = await installCentralAccount({ openAuthorization: async () => {
    const page = await networkFetch(returnTo)
    expect(page.headers.get("referrer-policy")).toBe("same-origin")
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self'")
    const html = await page.text()
    expect(html).toContain('<form method="post" action="/auth/complete">')
    expect(html).toContain("history.replaceState(null,'','/auth/callback')")
    expect(html).not.toContain("fetch(")
    const origin = new URL(returnTo).origin
    const body = new URLSearchParams({ code: loginCode })
    const rejected = await networkFetch(`${origin}/auth/complete`, { method: "POST", headers: { Origin: "https://other.example" }, body })
    expect(rejected.status).toBe(404)
    const accepted = await networkFetch(`${origin}/auth/complete`, { method: "POST", headers: { Origin: origin }, body })
    expect(accepted.status).toBe(200)
    expect(await accepted.text()).toBe("Signed in. You can close this tab.")
  } })
  clients.push(client)
  await client.login()
  expect(f.fetch).toHaveBeenCalledTimes(2)
  expect(JSON.parse(await readFile(f.path, "utf8")).encryptedToken).toBe(Buffer.from("encrypted-new-token").toString("base64"))
})

test("central IPC preserves network diagnostics for caught renderer failures without exposing request payloads", async () => {
  const f = await setup({ encryptedToken: Buffer.from("saved-token").toString("base64"), user })
  await f.install()
  const invoke = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === CENTRAL_CHANNEL)![1]
  const network = new TypeError("fetch failed", { cause: Object.assign(new Error("private-host.example:443"), { code: "ECONNRESET" }) })
  f.fetch.mockRejectedValueOnce(network)
  const report = vi.fn()
  const bridge: CentralBridge = {
    invoke: async (method, args) => structuredClone(await invoke({} as Electron.IpcMainInvokeEvent, method, args)) as CentralIpcResult,
    onEvent: () => () => {},
    context: vi.fn(),
  }
  const api = centralBridgeClient(bridge, report)
  const failure = await api.rpc("team", "private-machine", "_deskfleet/agent/configuration", { provider: "private-provider" }).catch(error => error)
  if (!(failure instanceof CentralRequestError)) throw new Error("Expected a central transport failure")
  expect(failure.message).toBe("Error invoking remote method 'deskfleet:central': TypeError: fetch failed")
  expect(failure.diagnostics).toMatchObject({ method: "POST", route: "/api/teams/:teamId/machines/:machineId/rpc", rpcMethod: "_deskfleet/agent/configuration", causes: [{ name: "TypeError" }, { name: "Error", code: "ECONNRESET" }] })
  expect(failure.stack).toContain("HttpCentralClient.request")
  expect(report).toHaveBeenCalledExactlyOnceWith(failure)
  expect(f.fetch).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(failure)).not.toMatch(/private-|restored-token|Authorization/)
})

test("central IPC distinguishes HTTP failures from network failures", async () => {
  const f = await setup()
  await f.install()
  const invoke = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === CENTRAL_CHANNEL)![1]
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "operation_failed", message: "Provider unavailable" } }), { status: 502 }))
  await expect(invoke({} as Electron.IpcMainInvokeEvent, "rpc", ["team", "machine", "_deskfleet/agent/configuration", {}])).resolves.toMatchObject({
    ok: false, error: { message: "Error invoking remote method 'deskfleet:central': Error: Provider unavailable",
      request: { diagnostics: { kind: "http", status: 502, rpcMethod: "_deskfleet/agent/configuration" } },
    },
  })
})
