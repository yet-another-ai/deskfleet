import { afterEach, expect, test, vi } from "vitest"
import { apiRequest } from "./api-request.ts"
import { CentralRequestError, HttpError, serializeCentralRequestError } from "./request-diagnostics.ts"

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

test.each(["POST", "PUT", "PATCH", "DELETE"])("%s is not automatically replayed after a network failure", async method => {
  const cause = new TypeError("fetch failed")
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(cause)
  await expect(apiRequest("https://fleet.example/api/teams", { method, json: { name: "Team" }, fetch })).rejects.toMatchObject({
    cause, diagnostics: { kind: "network", method },
  })
  expect(fetch).toHaveBeenCalledOnce()
})

test.each([401, 403, 409, 422])("HTTP %s preserves its business error without retrying", async status => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({ error: { code: "quota_reached", message: "Limit reached" } }, { status }))
  const error = await apiRequest("https://fleet.example/api/teams", { fetch }).catch(error => error)
  expect(error).toBeInstanceOf(HttpError)
  if (!(error instanceof HttpError)) throw error
  expect(error).toMatchObject({ status, code: "quota_reached", message: "Limit reached", diagnostics: { kind: "http" } })
  expect(error.response?.headers.get("content-type")).toBe("application/json")
  expect(fetch).toHaveBeenCalledOnce()
})

test("read timeouts get fresh attempts within one fifteen-second deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] })
  const signals: AbortSignal[] = []
  const fetch = vi.fn<typeof globalThis.fetch>(input => {
    const request = input as Request
    signals.push(request.signal)
    return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }))
  })
  const result = apiRequest("https://fleet.example/api/teams/private-team/billing", { fetch }).catch(error => error)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(signals[0]!.aborted).toBe(true)
  await vi.advanceTimersByTimeAsync(300)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(signals[1]!.aborted).toBe(false)
  expect(signals[1]).not.toBe(signals[0])
  await vi.advanceTimersByTimeAsync(9_700)
  const error = await result
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(error).toBeInstanceOf(CentralRequestError)
  expect(error).toMatchObject({ message: "The request timed out", diagnostics: { kind: "timeout", elapsedMs: 15_000 } })
  expect(JSON.stringify(serializeCentralRequestError(error))).not.toMatch(/fleet\.example|private-team/)
})

test("Retry-After is respected and caller cancellation interrupts the wait", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] })
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ error: { message: "Busy" } }, { status: 429, headers: { "Retry-After": "2" } }))
    .mockResolvedValue(Response.json({ ok: true }))
  const stop = new AbortController()
  const result = apiRequest("https://fleet.example/api/teams", { fetch, signal: stop.signal }).catch(error => error)
  await vi.advanceTimersByTimeAsync(1_999)
  expect(fetch).toHaveBeenCalledOnce()
  stop.abort()
  expect(await result).toMatchObject({ diagnostics: { kind: "cancelled" } })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(fetch).toHaveBeenCalledOnce()
})

test("Retry-After cannot extend the total request deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] })
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({}, { status: 503, headers: { "Retry-After": "60" } }))
  const result = apiRequest("https://fleet.example/api/teams", { fetch }).catch(error => error)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(await result).toMatchObject({ diagnostics: { kind: "timeout", elapsedMs: 15_000 } })
  expect(fetch).toHaveBeenCalledOnce()
})

test("a successful empty response is accepted without masking malformed JSON", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response("", { status: 200 }))
  await expect(apiRequest("https://fleet.example/api/teams", { method: "POST", fetch })).resolves.toBeUndefined()
  await expect(apiRequest("https://fleet.example/api/teams", { fetch })).rejects.toMatchObject({ diagnostics: { kind: "decode", phase: "response_body", status: 200 } })
  expect(fetch).toHaveBeenCalledTimes(2)
})
