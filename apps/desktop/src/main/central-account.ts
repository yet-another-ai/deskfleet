import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import { HttpCentralClient, type SavedAccount } from "@deskfleet/client/http-central"
import type { LocalEnrollment } from "@deskfleet/client/central"
import { DaemonClient } from "./daemon-client.ts"
import { isDesktopMediaSender } from "./desktop-media.ts"
import { enrollLocalMachine } from "./local-enrollment.ts"

export const CENTRAL_CHANNEL = "deskfleet:central"
export const CENTRAL_EVENT = "deskfleet:central-event"
interface StoredAccount { serverUrl: string; encryptedToken?: string; user?: SavedAccount["user"] }

async function readAccount(path: string): Promise<SavedAccount> {
  let value: StoredAccount
  try { value = JSON.parse(await readFile(path, "utf8")) as StoredAccount }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { serverUrl: "http://127.0.0.1:8080" }
    throw error
  }
  const token = value.encryptedToken && await safeStorage.isAsyncEncryptionAvailable()
    ? (await safeStorage.decryptStringAsync(Buffer.from(value.encryptedToken, "base64"))).result : undefined
  return { serverUrl: value.serverUrl, token, user: token ? value.user : undefined }
}
async function saveAccount(path: string, account: SavedAccount): Promise<void> {
  const encryptedToken = account.token && await safeStorage.isAsyncEncryptionAvailable()
    ? (await safeStorage.encryptStringAsync(account.token)).toString("base64") : undefined
  await mkdir(app.getPath("userData"), { recursive: true })
  await writeFile(path, JSON.stringify({ serverUrl: account.serverUrl, encryptedToken, user: encryptedToken ? account.user : undefined } satisfies StoredAccount), { mode: 0o600 })
}

/** A one-shot loopback callback receives the code; the verifier remains in the main process. */
async function authorize(client: HttpCentralClient, openAuthorization: (url: string) => Promise<unknown>): Promise<void> {
  let complete!: (code: string) => void
  let fail!: (error: Error) => void
  const code = new Promise<string>((resolve, reject) => { complete = resolve; fail = reject })
  void code.catch(() => {})
  const server = createServer(async (request, response) => {
    const address = server.address()
    if (!address || typeof address === "string") { response.writeHead(503).end(); return }
    const origin = `http://127.0.0.1:${address.port}`
    if (request.method === "GET" && request.url?.startsWith("/auth/callback")) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'" })
      response.end(`<!doctype html><html><meta charset="utf-8"><title>deskfleet</title><body><p id="status">deskfleet</p><script>const code=new URLSearchParams(location.hash.slice(1)).get('loginCode');history.replaceState(null,'','/auth/callback');if(code)fetch('/auth/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})}).then(r=>{document.getElementById('status').textContent=r.ok?'Signed in. You can close this tab.':'Sign-in failed.'});</script></body></html>`)
      return
    }
    if (request.method !== "POST" || request.url !== "/auth/complete" || request.headers.origin !== origin) { response.writeHead(404).end(); return }
    try {
      let body = ""
      for await (const chunk of request) { body += String(chunk); if (body.length > 8192) throw new Error("Invalid login response") }
      const result = JSON.parse(body) as { code?: unknown }
      if (typeof result.code !== "string" || !result.code) throw new Error("Missing login code")
      response.writeHead(200).end(); complete(result.code)
    } catch (error) { response.writeHead(400).end(); fail(error instanceof Error ? error : new Error("Invalid login response")) }
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not start login callback")
  const timeout = setTimeout(() => fail(new Error("Sign-in timed out")), 5 * 60_000)
  try {
    const result = await client.authorizationUrl(`http://127.0.0.1:${address.port}/auth/callback`)
    const url = new URL(result.authorizationUrl)
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Invalid authorization URL")
    await openAuthorization(url.toString())
    await client.exchange(await code, result.loginVerifier)
  } finally { clearTimeout(timeout); server.close(); server.closeAllConnections() }
}

async function daemonCall(method: "centralStatus" | "centralPrepareEnrollment" | "centralEnroll", params: unknown): Promise<LocalEnrollment> {
  const client = await DaemonClient.connect(() => {}, () => {})
  try { return await client.call(method, params as never) as LocalEnrollment }
  finally { client.close() }
}

export async function installCentralAccount(options: { openAuthorization?: (url: string) => Promise<unknown> } = {}): Promise<HttpCentralClient> {
  const path = join(app.getPath("userData"), "account.json")
  const client = new HttpCentralClient({ account: await readAccount(path), persist: account => saveAccount(path, account), authorize: client => authorize(client, options.openAuthorization ?? shell.openExternal) })
  const localEnrollment = () => daemonCall("centralStatus", {})
  const enrollLocal = (teamId: string, name?: string) => enrollLocalMachine(client, {
    status: localEnrollment,
    prepare: () => daemonCall("centralPrepareEnrollment", {}),
    enroll: credentials => daemonCall("centralEnroll", credentials),
  }, teamId, name)
  const methods: Record<string, (...args: never[]) => unknown> = Object.fromEntries([
    "status", "setServer", "login", "logout", "teams", "createTeam", "enrollHeadless", "members", "renameTeam", "invite", "acceptInvite", "setMemberRole", "removeMember", "machines", "renameMachine", "removeMachine", "catalog", "sessions", "session", "events", "rpc", "createPeer", "offerPeer", "startPeer", "candidatePeer", "closePeer",
  ].map(method => [method, (client[method as keyof HttpCentralClient] as (...args: never[]) => unknown).bind(client)]))
  methods.localEnrollment = localEnrollment
  methods.enrollLocal = enrollLocal
  ipcMain.handle(CENTRAL_CHANNEL, async (event, method: unknown, args: unknown) => {
    if (!isDesktopMediaSender(event) || typeof method !== "string" || !Array.isArray(args) || !Object.hasOwn(methods, method)) throw new Error("Invalid account operation")
    return await methods[method]!(...args as never[])
  })
  client.onEvent(event => { for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(CENTRAL_EVENT, event) })
  app.once("will-quit", () => client.dispose())
  return client
}
