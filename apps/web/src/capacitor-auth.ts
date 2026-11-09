import { App as CapApp } from "@capacitor/app"
import { Capacitor } from "@capacitor/core"
import { NativeDesktopPlugin } from "@deskfleet/capacitor-native-desktop"
import type { BrowserClientOptions } from "@deskfleet/client/browser"
import { serverAddress, type HttpCentralClient, type SavedAccount } from "@deskfleet/client/http-central"

const ACCOUNT_STORAGE_KEY = "deskfleet.capacitor.account"
const CUSTOM_AUTH_CALLBACK_URL = "ai.yetanother.deskfleet://auth/callback"
const AUTH_TIMEOUT_MS = 5 * 60_000

interface StoredCapacitorAccount {
  serverUrl?: string
  token?: string
  user?: SavedAccount["user"]
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
    await NativeDesktopPlugin.openExternal({ url: parsed.toString() })
    return
  }
  window.open(parsed.toString(), "_blank", "noopener,noreferrer")
}

async function authorizeCapacitor(client: HttpCentralClient): Promise<void> {
  if (Capacitor.getPlatform() === "android") {
    const { callbackUrl } = await NativeDesktopPlugin.startAuthCallback()
    const result = await client.authorizationUrl(callbackUrl)
    const parsed = new URL(result.authorizationUrl)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Invalid authorization URL")
    }
    const { code } = await NativeDesktopPlugin.waitForAuthCallback({
      authorizationUrl: parsed.toString(),
    })
    await client.exchange(code, result.loginVerifier)
    return
  }

  const result = await client.authorizationUrl(CUSTOM_AUTH_CALLBACK_URL)
  const parsed = new URL(result.authorizationUrl)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Invalid authorization URL")
  }

  let complete!: (code: string) => void
  let fail!: (error: Error) => void
  const codePromise = new Promise<string>((resolve, reject) => {
    complete = resolve
    fail = reject
  })
  void codePromise.catch(() => {})

  const handle = await CapApp.addListener("appUrlOpen", ({ url }) => {
    if (!url.startsWith(CUSTOM_AUTH_CALLBACK_URL)) return
    const hashIndex = url.indexOf("#")
    const hash = hashIndex >= 0 ? url.slice(hashIndex + 1) : ""
    const loginCode = new URLSearchParams(hash).get("loginCode")
    if (loginCode) complete(loginCode)
    else fail(new Error("Missing login code"))
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
