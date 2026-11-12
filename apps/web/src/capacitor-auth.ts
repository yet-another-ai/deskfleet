import { App as CapApp } from "@capacitor/app"
import { Capacitor } from "@capacitor/core"
import { DeskFleetBridge } from "@deskfleet/capacitor-bridge"
import type { BrowserClientOptions } from "@deskfleet/client/browser"
import { serverAddress, type HttpCentralClient, type SavedAccount } from "@deskfleet/client/http-central"

const ACCOUNT_STORAGE_KEY = "deskfleet.capacitor.account"
const CUSTOM_AUTH_CALLBACK_SCHEME = "ai.yetanother.deskfleet"
const CUSTOM_AUTH_CALLBACK_URL = `${CUSTOM_AUTH_CALLBACK_SCHEME}://auth/callback`
const AUTH_TIMEOUT_MS = 5 * 60_000

interface StoredCapacitorAccount {
  serverUrl?: string
  token?: string
  user?: SavedAccount["user"]
}

function isAuthCallbackUrl(url: string): boolean {
  const next = url[CUSTOM_AUTH_CALLBACK_URL.length]
  return url.slice(0, CUSTOM_AUTH_CALLBACK_URL.length).toLowerCase() === CUSTOM_AUTH_CALLBACK_URL
    && (next === undefined || next === "#" || next === "?" || next === "/")
}

function extractLoginCode(url: string): string {
  const hashIndex = url.indexOf("#")
  const loginCode = hashIndex >= 0 ? new URLSearchParams(url.slice(hashIndex + 1)).get("loginCode") : null
  if (!loginCode) throw new Error("Missing login code")
  return loginCode
}

function readCapacitorAccount(configuredServerUrl: string): SavedAccount {
  const serverUrl = serverAddress(configuredServerUrl)
  try {
    const raw = localStorage.getItem(ACCOUNT_STORAGE_KEY)
    if (!raw) return { serverUrl }
    const parsed = JSON.parse(raw) as StoredCapacitorAccount
    if (parsed.serverUrl !== serverUrl || typeof parsed.token !== "string" || !parsed.token) {
      return { serverUrl }
    }
    return { serverUrl, token: parsed.token, user: parsed.user }
  } catch {
    return { serverUrl }
  }
}

async function saveCapacitorAccount(account: SavedAccount): Promise<void> {
  if (account.token) {
    localStorage.setItem(
      ACCOUNT_STORAGE_KEY,
      JSON.stringify({
        serverUrl: account.serverUrl,
        token: account.token,
        user: account.user,
      } satisfies StoredCapacitorAccount),
    )
  } else {
    localStorage.removeItem(ACCOUNT_STORAGE_KEY)
  }
}

async function openCapacitorExternal(url: string): Promise<void> {
  const parsed = new URL(url)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Invalid external URL")
  }
  if (Capacitor.getPlatform() === "android") {
    await DeskFleetBridge.openExternal({ url: parsed.toString() })
    return
  }
  window.open(parsed.toString(), "_blank", "noopener,noreferrer")
}

async function authorizeCapacitor(client: HttpCentralClient): Promise<void> {
  const result = await client.authorizationUrl(CUSTOM_AUTH_CALLBACK_URL)
  const parsed = new URL(result.authorizationUrl)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Invalid authorization URL")
  }

  if (Capacitor.getPlatform() === "ios") {
    const callback = await DeskFleetBridge.authenticate({
      url: parsed.toString(),
      callbackScheme: CUSTOM_AUTH_CALLBACK_SCHEME,
    })
    if (!isAuthCallbackUrl(callback.url)) {
      throw new Error("Invalid authentication callback URL")
    }
    await client.exchange(extractLoginCode(callback.url), result.loginVerifier)
    return
  }

  let complete!: (code: string) => void
  let fail!: (error: Error) => void
  const codePromise = new Promise<string>((resolve, reject) => {
    complete = resolve
    fail = reject
  })
  void codePromise.catch(() => {})

  const handle = await CapApp.addListener("appUrlOpen", ({ url }) => {
    if (!isAuthCallbackUrl(url)) return
    try {
      complete(extractLoginCode(url))
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })

  const timeout = setTimeout(() => fail(new Error("Sign-in timed out")), AUTH_TIMEOUT_MS)
  try {
    await openCapacitorExternal(parsed.toString())
    await client.exchange(await codePromise, result.loginVerifier)
  } finally {
    clearTimeout(timeout)
    await handle.remove()
  }
}

export function capacitorClientOptions(configuredServerUrl: string): BrowserClientOptions {
  if (!Capacitor.isNativePlatform()) return {}
  return {
    mobile: true,
    account: readCapacitorAccount(configuredServerUrl),
    cookieAuth: false,
    persist: saveCapacitorAccount,
    authorize: authorizeCapacitor,
    openExternal: openCapacitorExternal,
  }
}
