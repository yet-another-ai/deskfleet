import { afterEach, expect, test, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HttpCentralClient } from "@deskfleet/client/http-central"

vi.mock("electron", () => ({
  app: { getPath: vi.fn(), once: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
  safeStorage: { isAsyncEncryptionAvailable: vi.fn(), decryptStringAsync: vi.fn(), encryptStringAsync: vi.fn() },
  shell: { openExternal: vi.fn() },
}))
vi.mock("./desktop-media.ts", () => ({ isDesktopMediaSender: () => true }))
vi.mock("./daemon-client.ts", () => ({ DaemonClient: { connect: vi.fn() } }))
vi.mock("./backend.ts", () => ({ backendUrl: "https://fleet.example/" }))
import { app, ipcMain, safeStorage } from "electron"
import { CENTRAL_CHANNEL, installCentralAccount } from "./central-account.ts"

const user = { id: "user-1", name: "Ada" }
const serverUrl = "https://fleet.example"
const roots: string[] = []
const clients: HttpCentralClient[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function setup(stored: Record<string, unknown> = {}) {
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
  expect(f.fetch).toHaveBeenCalledWith(`${serverUrl}/api/me`, expect.objectContaining({ headers: { Authorization: "Bearer restored-token" } }))
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
  expect(f.fetch).toHaveBeenCalledExactlyOnceWith(`${serverUrl}/api/site`, expect.objectContaining({ headers: {} }))
})

test("desktop IPC reads public site settings but rejects administration even for a site administrator", async () => {
  const f = await setup({ encryptedToken: Buffer.from("saved-token").toString("base64"), user })
  const client = await f.install()
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ user, siteAdmin: true })))
  expect((await client.status()).siteAdmin).toBe(true)
  f.fetch.mockClear()

  const settings = { siteName: "Studio fleet", announcement: "News", allowTeamCreation: false }
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify(settings)))
  const invoke = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === CENTRAL_CHANNEL)![1]
  const event = {} as Electron.IpcMainInvokeEvent
  await expect(invoke(event, "site", [])).resolves.toEqual(settings)
  await expect(invoke(event, "siteSettings", [])).rejects.toThrow("Invalid account operation")
  await expect(invoke(event, "setServer", ["https://other.example"])).rejects.toThrow("Invalid account operation")
  await expect(invoke(event, "updateSiteSettings", [settings])).rejects.toThrow("Invalid account operation")
  expect(f.fetch).toHaveBeenCalledExactlyOnceWith(`${serverUrl}/api/site`, expect.objectContaining({ method: "GET" }))
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
