import { expect, test, vi } from "vitest"
import { HttpCentralClient } from "./http-central.ts"
import { CentralRequestError, centralRequestFailure } from "./request-diagnostics.ts"
import { reportingCentral, withCentralRequestTrigger } from "./reporting-central.ts"

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

test("concurrent scopes retain their trigger and rescoping reports only once", async () => {
  const pending: Array<(error: Error) => void> = []
  const report = vi.fn()
  const central = reportingCentral({ teams: () => new Promise<void>((_, reject) => pending.push(reject)) }, report)
  const background = withCentralRequestTrigger(central, "background")
  const user = withCentralRequestTrigger(background, "user")
  const requests = [background.teams().catch(error => error), user.teams().catch(error => error), central.teams().catch(error => error)]
  const errors = requests.map(() => centralRequestFailure(new TypeError("Failed to fetch"), { method: "GET", path: "/api/teams", elapsedMs: 10 }))
  for (const index of [1, 2, 0]) pending[index]!(errors[index]!)
  expect(await Promise.all(requests)).toEqual(errors)
  expect(errors.map(error => error.diagnostics.trigger)).toEqual(["background", "user", "unknown"])
  expect(report).toHaveBeenCalledTimes(3)
})
