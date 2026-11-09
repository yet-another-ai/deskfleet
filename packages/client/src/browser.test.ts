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
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ user, siteAdmin: false })))
  vi.stubGlobal("fetch", fetch)
  const api = await browserClient(`${serverUrl}/`)
  const central = api.central as HttpCentralClient
  clients.push(central)
  return { central, fetch, storage }
}

test("a fresh browser account uses the configured backend", async () => {
  const f = await setup()
  expect(await f.central.status()).toEqual({ serverUrl, user, siteAdmin: false })
  expect(f.fetch).toHaveBeenCalledOnce()
  const request = f.fetch.mock.calls[0]![0] as Request
  expect(request).toMatchObject({ url: `${serverUrl}/api/me`, credentials: "include" })
  expect(Object.fromEntries(request.headers)).toEqual({ accept: "application/json" })
  await f.central.site()
  const siteRequest = f.fetch.mock.calls.at(-1)![0] as Request
  expect(siteRequest).toMatchObject({ url: `${serverUrl}/api/site`, credentials: "include" })
  expect(Object.fromEntries(siteRequest.headers)).toEqual({ accept: "application/json" })
  expect(f.storage.getItem("deskfleet.account")).toBeNull()
})

test("browser authentication uses cookies and ignores saved bearer credentials", async () => {
  const f = await setup({ serverUrl, token: "saved-token", user })
  expect(await f.central.status()).toEqual({ serverUrl, user, siteAdmin: false })
  expect(f.fetch).toHaveBeenCalledOnce()
  const request = f.fetch.mock.calls[0]![0] as Request
  expect(request).toMatchObject({ url: `${serverUrl}/api/me`, credentials: "include" })
  expect(Object.fromEntries(request.headers)).toEqual({ accept: "application/json" })
})

test("browser storage cannot override the configured backend or reuse another server's token", async () => {
  const f = await setup({ serverUrl: "https://old.example", token: "old-token", user })
  expect(await f.central.status()).toEqual({ serverUrl, user, siteAdmin: false })
  expect(f.fetch).toHaveBeenCalledOnce()
  const request = f.fetch.mock.calls[0]![0] as Request
  expect(request).toMatchObject({ url: `${serverUrl}/api/me`, credentials: "include" })
  expect(Object.fromEntries(request.headers)).toEqual({ accept: "application/json" })
  await f.central.site()
  const siteRequest = f.fetch.mock.calls.at(-1)![0] as Request
  expect(siteRequest).toMatchObject({ url: `${serverUrl}/api/site`, credentials: "include" })
  expect(Object.fromEntries(siteRequest.headers)).toEqual({ accept: "application/json" })
})

test("native bearer options omit cookies and attach the saved bearer token", async () => {
  await setup()
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ user, siteAdmin: false })))
  vi.stubGlobal("fetch", fetch)
  const api = await browserClient(`${serverUrl}/`, () => {}, {
    mobile: true,
    account: { serverUrl, token: "native-token", user },
    cookieAuth: false,
  })
  expect(api.mobile).toBe(true)
  expect(api.siteAdministration).toBeUndefined()
  const central = api.central as HttpCentralClient
  clients.push(central)
  expect(await central.status()).toEqual({ serverUrl, user, siteAdmin: false })
  expect(fetch).toHaveBeenCalledOnce()
  const request = fetch.mock.calls[0]![0] as Request
  expect(request).toMatchObject({ url: `${serverUrl}/api/me`, credentials: "omit" })
  expect(Object.fromEntries(request.headers)).toEqual({
    accept: "application/json",
    authorization: "Bearer native-token",
  })
})
