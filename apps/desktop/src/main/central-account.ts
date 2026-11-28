import { app, BrowserWindow, ipcMain, powerMonitor, safeStorage, shell } from "electron"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import { HttpCentralClient, serverAddress, type SavedAccount } from "@deskfleet/client/http-central"
import { CENTRAL_METHODS, centralIpcFailure } from "@deskfleet/client/central-bridge"
import type { CentralEvent } from "@deskfleet/client/central"
import { setPeerTelemetrySink } from "@deskfleet/client/peer-telemetry"
import type { ControlMethods } from "@deskfleet/protocol/control"
import { DaemonClient } from "./daemon-client.ts"
import { isDesktopMediaSender } from "./desktop-media.ts"
import { enrollLocalMachine } from "./local-enrollment.ts"
import { backendUrl } from "./backend.ts"
import { desktopErrorReportingContext } from "./error-reporting-context.ts"
import { desktopCentralTransport } from "./central-transport.ts"

export const CENTRAL_CHANNEL = "deskfleet:central"
export const CENTRAL_EVENT = "deskfleet:central-event"
export const CENTRAL_CONTEXT_CHANNEL = "deskfleet:central-context"
interface StoredAccount { serverUrl: string; encryptedToken?: string; user?: SavedAccount["user"] }

async function readAccount(path: string): Promise<SavedAccount> {
  const serverUrl = serverAddress(backendUrl)
  let parsed: unknown
  try { parsed = JSON.parse(await readFile(path, "utf8")) }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { serverUrl }
    // An unreadable or corrupted account file must not abort app startup or
    // overwrite the saved file; start signed out until a fresh sign-in succeeds.
    console.warn("Could not read saved desktop account", error)
    return { serverUrl }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as StoredAccount).serverUrl !== "string") {
    console.warn("Saved desktop account file has an unexpected format")
    return { serverUrl }
  }
  const value = parsed as StoredAccount
  if (value.serverUrl !== serverUrl) return { serverUrl }
  let token: string | undefined
  if (typeof value.encryptedToken === "string" && value.encryptedToken) {
    try {
      if (await safeStorage.isAsyncEncryptionAvailable()) {
        token = (await safeStorage.decryptStringAsync(Buffer.from(value.encryptedToken, "base64"))).result
      }
    } catch (error) {
      // A locked/cancelled Linux keyring or switched password-store backend
      // must not abort app startup or overwrite the saved account file.
      console.warn("Could not decrypt saved desktop account token", error)
    }
  }
  return { serverUrl, token, user: token ? value.user : undefined }
}
async function saveAccount(path: string, account: SavedAccount): Promise<void> {
  const encryptedToken = account.token && await safeStorage.isAsyncEncryptionAvailable()
    ? (await safeStorage.encryptStringAsync(account.token)).toString("base64") : undefined
  await mkdir(app.getPath("userData"), { recursive: true })
  const stored: StoredAccount = { serverUrl: account.serverUrl, encryptedToken, user: encryptedToken ? account.user : undefined }
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(stored), { mode: 0o600, flag: "wx" })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

const DESKTOP_SCHEME = "ai.yetanother.deskfleet"
const DESKTOP_CALLBACK = "ai.yetanother.deskfleet://auth/callback"
const LOGIN_TIMEOUT_MS = 5 * 60_000
const MISSING_LOGIN_CODE = "Sign-in failed. The browser did not return a login code."
// The same-origin forms carry the code or the failure reason. A missing code is
// reported instead of only changing the page text, so the app stops waiting.
const CALLBACK_PAGE = `<!doctype html><html><meta charset="utf-8"><title>DeskFleet</title><body><p id="status">Signing in…</p><form method="post" action="/auth/complete"><input type="hidden" name="code"></form><form method="post" action="/auth/failed"><input type="hidden" name="reason"></form><script>const code=new URLSearchParams(location.hash.slice(1)).get('loginCode');history.replaceState(null,'','/auth/callback');const forms=document.querySelectorAll('form');if(code){forms[0].elements.code.value=code;forms[0].submit();}else{forms[1].elements.reason.value='missing_code';forms[1].submit();}</script></body></html>`

type AuthCallback = "loopback" | "scheme"

/** A one-shot callback receives the code; the verifier remains in the main process. */
interface AuthReceiver {
  returnTo: string
  code: Promise<string>
  fail(error: Error): void
  close(): void
}

let pendingAuthCallback: ((code: string | undefined) => void) | undefined

/** Registers the packaged macOS deep link before Electron becomes ready. */
export function installDesktopProtocol(): void {
  if (process.platform !== "darwin") return
  app.on("open-url", (event, url) => {
    event.preventDefault()
    receiveAuthCallback(url)
  })
  if (!app.isPackaged) return
  try { app.setAsDefaultProtocolClient(DESKTOP_SCHEME) }
  catch (error) { console.warn("Could not register the DeskFleet sign-in scheme", error) }
}

/** macOS delivers custom-scheme callbacks through `open-url`; only our path is accepted. */
export function receiveAuthCallback(value: string): void {
  let url: URL
  try { url = new URL(value) } catch { return }
  if (url.protocol !== `${DESKTOP_SCHEME}:` || url.host !== "auth" || url.pathname !== "/callback"
    || url.username || url.password) return
  const code = new URLSearchParams(url.hash.slice(1)).get("loginCode") ?? undefined
  pendingAuthCallback?.(code)
}

function deferredCode(): { code: Promise<string>; complete(code: string): void; fail(error: Error): void } {
  let complete!: (code: string) => void
  let fail!: (error: Error) => void
  let settled = false
  const code = new Promise<string>((resolve, reject) => {
    complete = value => { if (!settled) { settled = true; resolve(value) } }
    fail = error => { if (!settled) { settled = true; reject(error) } }
  })
  void code.catch(() => {})
  return { code, complete, fail }
}

/** Safari blocks HTTP loopback navigation under HTTPS-Only, so macOS hands the custom scheme to the running app. */
function schemeReceiver(): AuthReceiver {
  const { code, complete, fail } = deferredCode()
  const handler = (value: string | undefined) => value ? complete(value) : fail(new Error(MISSING_LOGIN_CODE))
  pendingAuthCallback = handler
  // A newer login may have replaced the handler before this attempt closes.
  return { returnTo: DESKTOP_CALLBACK, code, fail, close: () => { if (pendingAuthCallback === handler) pendingAuthCallback = undefined } }
}

async function loopbackReceiver(): Promise<AuthReceiver> {
  const { code, complete, fail } = deferredCode()
  const server = createServer(async (request, response) => {
    const address = server.address()
    if (!address || typeof address === "string") { response.writeHead(503).end(); return }
    const origin = `http://127.0.0.1:${address.port}`
    if (request.method === "GET" && request.url?.startsWith("/auth/callback")) {
      // A same-origin form needs its real Origin header; no-referrer makes it null.
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "same-origin", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; form-action 'self'" })
      response.end(CALLBACK_PAGE)
      return
    }
    if (request.method !== "POST" || request.headers.origin !== origin) { response.writeHead(404).end(); return }
    try {
      let body = ""
      for await (const chunk of request) { body += String(chunk); if (body.length > 8192) throw new Error("Invalid login response") }
      if (request.url === "/auth/complete") {
        const loginCode = new URLSearchParams(body).get("code")
        if (!loginCode) throw new Error("Missing login code")
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end("Signed in. You can close this tab.")
        complete(loginCode)
        return
      }
      if (request.url === "/auth/failed") {
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end("Sign-in failed. Return to DeskFleet and try again.")
        const reason = new URLSearchParams(body).get("reason")
        fail(new Error(reason === "missing_code" ? MISSING_LOGIN_CODE : "Sign-in failed. Return to DeskFleet and try again."))
        return
      }
      response.writeHead(404).end()
    } catch (error) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end("Sign-in failed.")
      fail(error instanceof Error ? error : new Error("Invalid login response"))
    }
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const address = server.address()
  if (!address || typeof address === "string") { server.close(); throw new Error("Could not start login callback") }
  return {
    returnTo: `http://127.0.0.1:${address.port}/auth/callback`,
    code, fail,
    close: () => { server.close(); server.closeAllConnections() },
  }
}

async function finishLogin(client: HttpCentralClient, openAuthorization: (url: string) => Promise<unknown>, receiver: AuthReceiver, started: { authorizationUrl: string; loginVerifier: string }): Promise<void> {
  const timeout = setTimeout(() => receiver.fail(new Error("Sign-in timed out. Return to DeskFleet and try again.")), LOGIN_TIMEOUT_MS)
  try {
    const url = new URL(started.authorizationUrl)
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Invalid authorization URL")
    await openAuthorization(url.toString())
    await client.exchange(await receiver.code, started.loginVerifier)
  } finally { clearTimeout(timeout) }
}

async function authorize(client: HttpCentralClient, openAuthorization: (url: string) => Promise<unknown>, callback: AuthCallback): Promise<void> {
  const receiver = callback === "scheme" ? schemeReceiver() : await loopbackReceiver()
  try {
    const started = await client.authorizationUrl(receiver.returnTo)
    await finishLogin(client, openAuthorization, receiver, started)
  } finally { receiver.close() }
}

async function daemonCall<M extends "centralStatus" | "centralPrepareEnrollment" | "centralEnroll">(method: M, params: ControlMethods[M]["params"]): Promise<ControlMethods[M]["result"]> {
  const client = await DaemonClient.connect(() => {}, () => {})
  try { return await client.call(method, params) }
  finally { client.close() }
}

export async function installCentralAccount(options: { openAuthorization?: (url: string) => Promise<unknown>; authCallback?: AuthCallback } = {}): Promise<HttpCentralClient> {
  const path = join(app.getPath("userData"), "account.json")
  const authCallback = options.authCallback ?? (process.platform === "darwin" && app.isPackaged ? "scheme" : "loopback")
  let suspendEpoch = 0
  const client = new HttpCentralClient({ ...desktopCentralTransport, suspendEpoch: () => suspendEpoch, account: await readAccount(path), persist: account => saveAccount(path, account), authorize: client => authorize(client, options.openAuthorization ?? shell.openExternal, authCallback), openExternal: shell.openExternal })
  const localEnrollment = () => daemonCall("centralStatus", {})
  const enrollLocal = (teamId: string, name?: string) => enrollLocalMachine(client, {
    status: localEnrollment,
    prepare: target => daemonCall("centralPrepareEnrollment", target),
    enroll: credentials => daemonCall("centralEnroll", credentials),
  }, teamId, name)
  const methods: Record<string, (...args: never[]) => unknown> = Object.fromEntries(CENTRAL_METHODS
    .filter(method => method !== "localEnrollment" && method !== "enrollLocal")
    .map(method => [method, (client[method as keyof HttpCentralClient] as (...args: never[]) => unknown).bind(client)]))
  methods.localEnrollment = localEnrollment
  methods.enrollLocal = enrollLocal
  ipcMain.handle(CENTRAL_CHANNEL, async (event, method: unknown, args: unknown) => {
    if (!isDesktopMediaSender(event) || typeof method !== "string" || !Array.isArray(args) || !Object.hasOwn(methods, method)) throw new Error("Invalid account operation")
    try { return { ok: true, value: await methods[method]!(...args as never[]) } }
    catch (error) { return centralIpcFailure(error) }
  })
  ipcMain.handle(CENTRAL_CONTEXT_CHANNEL, event => {
    if (!isDesktopMediaSender(event)) throw new Error("Invalid account operation")
    return desktopErrorReportingContext()
  })
  const broadcast = (event: CentralEvent) => { for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(CENTRAL_EVENT, event) }
  client.onEvent(broadcast)
  // File and port peers live in main; the renderer owns the analytics SDK.
  const stopTelemetry = setPeerTelemetrySink(event => broadcast({ type: "peerTelemetry", event }))
  const wake = () => client.wake()
  const onSuspend = () => { suspendEpoch++ }
  const onResume = () => { suspendEpoch++; wake() }
  // Initial window creation and duplicate focus notifications are not a resume.
  let blurred = false
  const blur = () => { blurred = true }
  const focus = () => {
    if (!blurred) return
    blurred = false
    wake()
  }
  powerMonitor.on("suspend", onSuspend)
  powerMonitor.on("resume", onResume)
  app.on("browser-window-blur", blur)
  app.on("browser-window-focus", focus)
  app.once("will-quit", () => {
    powerMonitor.removeListener("suspend", onSuspend)
    powerMonitor.removeListener("resume", onResume)
    app.removeListener("browser-window-blur", blur)
    app.removeListener("browser-window-focus", focus)
    stopTelemetry(); client.dispose()
  })
  return client
}
