import { afterEach, expect, test, vi } from "vitest"
import { browserClient } from "./browser.ts"
import { HttpCentralClient } from "./http-central.ts"

const clients: HttpCentralClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
  vi.unstubAllGlobals()
})

const serverUrl = "https://fleet.example"
const user = { id: "user-1", name: "Ada" }

async function setup(saved?: { serverUrl: string; token: string; user: typeof user }) {
  const values = new Map<string, string>()
  if (saved) values.set("deskfleet.account", JSON.stringify(saved))
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
  vi.stubGlobal("sessionStorage", storage)
  vi.stubGlobal("localStorage", storage)
  vi.stubGlobal("location", { origin: "https://app.example", pathname: "/", hash: "" })
  vi.stubGlobal("navigator", { languages: ["en-US"] })
  vi.stubGlobal("window", new EventTarget())
  vi.stubGlobal("WebSocket", class { close() {} })
  const fetch = vi.fn(async () => new Response(JSON.stringify({ user, siteAdmin: false })))
  vi.stubGlobal("fetch", fetch)
  const api = await browserClient(`${serverUrl}/`)
  const central = api.central as HttpCentralClient
  clients.push(central)
  return { central, fetch, storage }
}

test("a fresh browser account uses the configured backend", async () => {
  const f = await setup()
  expect(await f.central.status()).toEqual({ serverUrl, user, siteAdmin: false })
  expect(f.fetch).toHaveBeenCalledExactlyOnceWith(`${serverUrl}/api/me`, expect.objectContaining({ credentials: "include", headers: {} }))
  await f.central.site()
  expect(f.fetch).toHaveBeenLastCalledWith(`${serverUrl}/api/site`, expect.objectContaining({ credentials: "include", headers: {} }))
  expect(f.storage.getItem("deskfleet.account")).toBeNull()
})

test("browser authentication uses cookies and ignores saved bearer credentials", async () => {
  const f = await setup({ serverUrl, token: "saved-token", user })
  expect(await f.central.status()).toEqual({ serverUrl, user, siteAdmin: false })
  expect(f.fetch).toHaveBeenCalledExactlyOnceWith(`${serverUrl}/api/me`, expect.objectContaining({ credentials: "include", headers: {} }))
})

test("browser storage cannot override the configured backend or reuse another server's token", async () => {
  const f = await setup({ serverUrl: "https://old.example", token: "old-token", user })
  expect(await f.central.status()).toEqual({ serverUrl, user, siteAdmin: false })
  expect(f.fetch).toHaveBeenCalledExactlyOnceWith(`${serverUrl}/api/me`, expect.objectContaining({ credentials: "include", headers: {} }))
  await f.central.site()
  expect(f.fetch).toHaveBeenLastCalledWith(`${serverUrl}/api/site`, expect.objectContaining({ credentials: "include", headers: {} }))
})
