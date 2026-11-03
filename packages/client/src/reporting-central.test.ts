import { expect, test, vi } from "vitest"
import { HttpCentralClient } from "./http-central.ts"
import { CentralRequestError } from "./request-diagnostics.ts"
import { reportingCentral } from "./reporting-central.ts"

test("reports once at the browser API boundary, preserving private fields and synchronous subscriptions", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("Failed to fetch"))
  const report = vi.fn()
  const client = reportingCentral(new HttpCentralClient({ account: { serverUrl: "https://fleet.example" }, persist: async () => {}, authorize: async () => {}, fetch, transport: "browser_fetch" }), report)
  try {
    const unsubscribe = client.onEvent(() => {})
    expect(typeof unsubscribe).toBe("function")
    const error = await client.teams().catch(error => error)
    expect(error).toBeInstanceOf(CentralRequestError)
    expect(error.diagnostics).toMatchObject({ transport: "browser_fetch", route: "/api/teams" })
    expect(report).toHaveBeenCalledExactlyOnceWith(error)
    unsubscribe()
  } finally { client.dispose() }
})

test("internal login recovery is completed before reporting", async () => {
  const report = vi.fn()
  const client = reportingCentral(new HttpCentralClient({ account: { serverUrl: "https://fleet.example", token: "private" }, persist: async () => {}, authorize: async () => {}, fetch: vi.fn().mockResolvedValue(new Response("{}", { status: 401 })) }), report)
  try {
    expect((await client.status()).user).toBeUndefined()
    expect(report).not.toHaveBeenCalled()
  } finally { client.dispose() }
})
