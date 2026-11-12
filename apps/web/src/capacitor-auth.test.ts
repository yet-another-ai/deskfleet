import { beforeEach, expect, test, vi } from "vitest"
import type { HttpCentralClient } from "@deskfleet/client/http-central"
import { capacitorClientOptions } from "./capacitor-auth.ts"

const mocks = vi.hoisted(() => ({
  platform: "ios",
  authenticate: vi.fn<() => Promise<{ url: string }>>(),
  openExternal: vi.fn<() => Promise<void>>(),
  addListener: vi.fn(),
}))

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => mocks.platform },
}))
vi.mock("@capacitor/app", () => ({ App: { addListener: mocks.addListener } }))
vi.mock("@deskfleet/capacitor-bridge", () => ({ DeskFleetBridge: mocks }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} })
})

function mockClient(attempt: string, loginVerifier: string) {
  const authorizationUrl = vi.fn(async () => ({
    authorizationUrl: `https://deskfleet.yetanother.ai/auth/desktop?attempt=${attempt}`,
    loginVerifier,
  }))
  const exchange = vi.fn(async () => {})
  return { client: { authorizationUrl, exchange } as unknown as HttpCentralClient, authorizationUrl, exchange }
}

test("authorize uses ASWebAuthenticationSession on iOS and rejects canceled or malformed callbacks", async () => {
  mocks.platform = "ios"
  mocks.authenticate
    .mockResolvedValueOnce({ url: "ai.yetanother.deskfleet://auth/callback#loginCode=ios-code" })
    .mockRejectedValueOnce(new Error("Sign-in canceled"))
    .mockResolvedValueOnce({ url: "https://evil.example/callback#loginCode=bad" })
    .mockResolvedValueOnce({ url: "ai.yetanother.deskfleet://auth/callback#other=1" })

  const options = capacitorClientOptions("https://deskfleet.yetanother.ai")
  const { client, authorizationUrl, exchange } = mockClient("ios-1", "verifier-1")

  await options.authorize!(client)
  expect(authorizationUrl).toHaveBeenCalledExactlyOnceWith("ai.yetanother.deskfleet://auth/callback")
  expect(mocks.authenticate).toHaveBeenCalledExactlyOnceWith({
    url: "https://deskfleet.yetanother.ai/auth/desktop?attempt=ios-1",
    callbackScheme: "ai.yetanother.deskfleet",
  })
  expect(exchange).toHaveBeenCalledExactlyOnceWith("ios-code", "verifier-1")
  expect(mocks.addListener).not.toHaveBeenCalled()

  await expect(options.authorize!(client)).rejects.toThrow("Sign-in canceled")
  await expect(options.authorize!(client)).rejects.toThrow("Invalid authentication callback URL")
  await expect(options.authorize!(client)).rejects.toThrow("Missing login code")
  expect(exchange).toHaveBeenCalledTimes(1)
})

test("authorize preserves Android external browser + appUrlOpen flow", async () => {
  mocks.platform = "android"
  let urlListener: ((event: { url: string }) => void) | undefined
  const remove = vi.fn(async () => {})
  mocks.addListener.mockImplementation(async (_event: string, fn: (event: { url: string }) => void) => {
    urlListener = fn
    return { remove }
  })
  mocks.openExternal.mockImplementation(async () => {
    urlListener?.({ url: "ai.yetanother.deskfleet://other#loginCode=ignored" })
    urlListener?.({ url: "ai.yetanother.deskfleet://auth/callback#loginCode=android-code" })
  })

  const options = capacitorClientOptions("https://deskfleet.yetanother.ai")
  const { client, exchange } = mockClient("android-1", "verifier-android")

  await options.authorize!(client)
  expect(mocks.authenticate).not.toHaveBeenCalled()
  expect(exchange).toHaveBeenCalledExactlyOnceWith("android-code", "verifier-android")
  expect(remove).toHaveBeenCalledOnce()
})
