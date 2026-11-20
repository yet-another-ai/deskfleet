import { readDesktopRoutes } from "./desktop-routes.ts"
import { runDesktopAcp } from "./desktop-acp.ts"
import { createRequire } from "node:module"
import { request } from "node:http"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { ReadStream } from "node:tty"
import type { Readable } from "node:stream"

export interface AccountState {
  status: "signed-out" | "credential-stored"
  attempt: null | {
    id: string
    phase: "initializing" | "waiting-browser" | "exchanging" | "committing" | "succeeded" | "cancelled" | "expired" | "failed"
    authorizeUrl?: string
    errorCode?: string
  }
}

export interface AccountStatus {
  auth: "authenticated" | "unauthenticated" | "unknown"
  method?: "account" | "api-key"
}

interface Account {
  getState(): Promise<AccountState>
  startSignIn(metadata: { version: string; locale: string; timezoneOffsetSeconds: number }, origin: string, source: "web"): Promise<AccountState>
  cancelSignIn(id: string): Promise<AccountState>
  watch(signal: AbortSignal): AsyncIterable<AccountState>
}

export interface AccountServices {
  account?: Account
  accountStored(): Promise<boolean>
  apiKeyConfigured(): Promise<boolean>
  origin?: string
  version: string
  environment: unknown
  coordinate?(input: CoordinatorInput): Promise<unknown>
  dispose(): Promise<void>
}

interface PluginHandle extends PromiseLike<unknown> {
  dispose(): Promise<void>
}

/** The setup loader reads the Harness home as its only file; keep that file's trust source. */
function harnessHomeEnvironment(snapshot: {
  getFrom(name: string, sources: readonly string[]): { source: string; value: string; path?: string } | undefined
}) {
  const getFrom = (name: string, sources: readonly string[]) => {
    const value = snapshot.getFrom(name, [
      ...sources.includes("process") ? ["process"] : [],
      ...sources.includes("user-env") ? ["project-env"] : [],
    ])
    return value?.source === "project-env" ? { ...value, source: "user-env" } : value
  }
  return { get: (name: string) => getFrom(name, ["process", "user-env"]), getFrom }
}

/** Resolve each module through the pinned upstream tree, including pnpm's isolated layout. */
export async function createAccountServices(entryPoint: string, login = false, options: {
  platform?: Record<string, unknown>
  home?: string
  environment?: unknown
  projectEnv?: boolean
  inference?: boolean
} = {}): Promise<AccountServices> {
  const runtime = createRequire(entryPoint)
  const base = createRequire(runtime.resolve("@deepseek-ai/dsh-base/package.json"))
  const accountRequire = createRequire(base.resolve("@deepseek-ai/dsh-deepseek-account-platform"))
  const load = (name: string, resolve = base) => import(pathToFileURL(resolve.resolve(name)).href)
  const [{ Context }, { LocalCredentialProvider }, { default: AuthorizationService }, { PlatformAccount },
    { credentialRef, credentialKey }, { loadLayeredEnv }, { resolveDshHome }] = await Promise.all([
    load("@deepseek-ai/cordis"), load("@deepseek-ai/dsh-credentials-local"),
    load("@deepseek-ai/dsh-authorization"), load("@deepseek-ai/dsh-deepseek-account-platform"),
    load("@deepseek-ai/dsh-credentials", accountRequire), load("@deepseek-ai/dsh-app-boot", runtime),
    load("@deepseek-ai/dsh-home-paths", runtime),
  ])
  const ctx = new Context()
  const handles: PluginHandle[] = []
  let disposeProxy: (() => Promise<void>) | undefined
  const dispose = async () => {
    const errors: unknown[] = []
    for (const handle of handles.reverse()) {
      try { await handle.dispose() } catch (error) { errors.push(error) }
    }
    try { await disposeProxy?.() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, "DeepSeek account cleanup failed")
  }
  try {
    // Setup has no workspace. Only ACP may load an invoking directory's project .env.
    const environment = options.environment ?? (options.projectEnv ? loadLayeredEnv("dsh")
      : harnessHomeEnvironment(loadLayeredEnv("dsh", resolveDshHome())))
    ctx.provide("launchEnvironment", environment)
    const mount = async (plugin: unknown, config?: unknown, scope = ctx) => {
      const handle = scope.plugin(plugin, config) as PluginHandle
      handles.push(handle)
      await handle
    }
    const accountKey = credentialKey("deepseek-account-platform", "default")
    const apiKeyConfigured = async () => (await ctx.credentials.describe(credentialRef("DEEPSEEK_API_KEY"))).configured as boolean
    if (login || options.inference) {
      const { installProxyFromEnvironment } = await load("@deepseek-ai/dsh-http-proxy", runtime)
      disposeProxy = await installProxyFromEnvironment(environment, (message: string) => process.stderr.write(`dsh: ${message}\n`))
    }
    const desktop = options.inference ? await readDesktopRoutes(entryPoint) : undefined
    const hasDesktop = desktop && Object.keys(desktop.providers).length > 0
    if (options.inference) await mount((await load("@deepseek-ai/dsh-llm")).default)
    let deepseek = "deepseek-official"
    try {
      await mount(LocalCredentialProvider, { watch: false, ...options.home ? { dshHome: options.home } : {},
        ...process.env.DESKFLEET_DSH_CREDENTIALS_PATH ? { path: process.env.DESKFLEET_DSH_CREDENTIALS_PATH } : {} })
      const useAccount = !login && options.inference && !await apiKeyConfigured()
      if (login || useAccount) {
        const config = PlatformAccount.Config(options.platform ?? {})
        const stored = await ctx.credentials.readRecord(accountKey)
        // The upstream constructor removes foreign-issuer grants. Reject before mounting it.
        if (stored && (stored.kind !== "grant" || stored.payload?.issuer !== config.platformOrigin)) {
          throw new Error("Existing account credentials use another Harness account configuration")
        }
        await mount(AuthorizationService)
        if (login) {
          const { default: WebServer } = await load("@deepseek-ai/dsh-host-webserver", accountRequire)
          await mount(WebServer, { host: "127.0.0.1", port: 0 })
        }
        await mount(PlatformAccount, config)
      }
      if (options.inference) {
        deepseek = useAccount ? "deepseek-account" : "deepseek-official"
        await mount(await load(useAccount ? "@deepseek-ai/dsh-llm-deepseek-account" : "@deepseek-ai/dsh-llm-deepseek-api-key"))
      }
    } catch (error) {
      if (!hasDesktop) throw error
      // A stale registration grant must not prevent independent desktop routes from loading.
      process.stderr.write("DSH registration model route is unavailable. Check its credentials.\n")
    }
    if (hasDesktop) {
      // Only bundled model adapters run in this tool-free coordinator. Desktop credentials
      // remain isolated from both the registration's official route and its login flow.
      const scope = ctx.isolate("credentials")
      try {
        await mount(LocalCredentialProvider, { dshHome: desktop.home, watch: false }, scope)
        await mount(await load("@deepseek-ai/dsh-llm-pi-ai"), { providers: desktop.providers }, scope)
      } catch (error) {
        if (!ctx.llm.listProviders().length) throw error
        process.stderr.write("DSH desktop model routes could not start. Check the desktop Models configuration.\n")
      }
    }
    return {
      ...(options.inference ? { coordinate: async (input: CoordinatorInput) => {
        if (input.images?.length) await mount((await load("@deepseek-ai/dsh-attachment-local")).default, { dshHome: process.cwd() })
        return coordinate(ctx, deepseek, desktop?.preferred, input)
      } } : {}),
      account: login ? ctx.deepseekAccount as Account : undefined,
      accountStored: async () => (await ctx.credentials.describeRecord(accountKey)).configured,
      apiKeyConfigured,
      origin: login ? ctx.webServer.getOrigin() as string : undefined,
      version: runtime("../package.json").version as string,
      environment,
      dispose,
    }
  } catch (error) {
    await dispose()
    throw error
  }
}

/** Presence only; neither a stored key nor a saved account proves remote acceptance. */
export async function accountStatus(services: Pick<AccountServices, "accountStored" | "apiKeyConfigured">): Promise<AccountStatus> {
  if (await services.apiKeyConfigured()) return { auth: "authenticated", method: "api-key" }
  if (await services.accountStored()) return { auth: "authenticated", method: "account" }
  return { auth: "unauthenticated" }
}

export function acpPatchFiles(status: AccountStatus, credentialsPath = process.env.DESKFLEET_DSH_CREDENTIALS_PATH,
  directory = import.meta.dirname): string[] {
  return [...credentialsPath ? [join(directory, "credentials-acp.yml")] : [],
    ...status.method === "account" ? [join(directory, "account-acp.yml")] : []]
}

/** A pasted browser redirect may only reach this attempt's own loopback callback. */
export function callbackUrl(value: string, origin: string): string | undefined {
  try {
    const url = new URL(value.trim())
    const local = new URL(origin)
    if (local.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(local.hostname)
      || !local.port || url.origin !== local.origin || url.pathname !== "/oauth/callback"
      || url.username || url.password || url.hash) return undefined
    if (url.searchParams.getAll("state").length !== 1 || !url.searchParams.get("state")
      || url.searchParams.getAll("code").length !== 1 || !url.searchParams.get("code")
      || [...url.searchParams.keys()].some(key => key !== "code" && key !== "state")) return undefined
    return url.href
  } catch { return undefined }
}

/** OAuth callback codes stay on loopback even when login's fetch dispatcher uses an outbound proxy. */
export function relayCallback(url: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const pending = request(url, { agent: false, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }, response => {
      response.resume()
      response.once("end", () => resolve(response.statusCode ?? 500))
      response.once("error", reject)
    })
    pending.once("error", reject)
    pending.end()
  })
}

/** Mask callback input at a real terminal; pipe carriers must also suppress their own terminal echo. */
export function readHiddenLines(input: Readable, receive: (line: string) => void, cancel: () => void): () => void {
  const terminal = input as ReadStream
  const wasRaw = terminal.isRaw
  if (terminal.isTTY) terminal.setRawMode(true)
  let line = ""
  const data = (chunk: Buffer | string) => {
    for (const character of chunk.toString()) {
      if (character === "\u0003" || character === "\u0004") { cancel(); continue }
      if (character === "\r" || character === "\n") {
        if (line) receive(line)
        line = ""
      } else if (character === "\u007f" || character === "\b") line = line.slice(0, -1)
      else if (character >= " " && line.length < 16_384) line += character
    }
  }
  input.on("data", data)
  input.once("end", cancel)
  input.resume()
  return () => {
    input.off("data", data)
    input.off("end", cancel)
    input.pause()
    if (terminal.isTTY) terminal.setRawMode(wasRaw)
    line = ""
  }
}

/** The upstream plugin owns PKCE, state validation, timeouts, and credential commit. */
export async function runAccountLogin(services: AccountServices, options: {
  input?: Readable
  write?: (text: string) => void
  signal?: AbortSignal
  relay?: (url: string, signal: AbortSignal) => Promise<number>
} = {}): Promise<boolean> {
  if (!services.origin || !services.account) throw new Error("DeepSeek login requires a callback listener")
  const origin = services.origin
  const account = services.account
  const write = options.write ?? (text => process.stdout.write(text))
  const abort = new AbortController()
  const signal = options.signal ? AbortSignal.any([abort.signal, options.signal]) : abort.signal
  const relay = options.relay ?? relayCallback
  let attemptId: string | undefined
  let busy = false
  let stopInput: (() => void) | undefined
  const pending = new Set<Promise<void>>()
  const cancel = () => abort.abort()
  const onSignal = () => cancel()
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
  try {
    const initial = await account.startSignIn({
      version: services.version, locale: process.env.LANG ?? "en-US",
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }, origin, "web")
    attemptId = initial.attempt?.id
    stopInput = readHiddenLines(options.input ?? process.stdin, line => {
      if (busy || signal.aborted) return
      const callback = callbackUrl(line, origin)
      if (!callback) { write("That is not this sign-in attempt's callback URL. Paste the complete redirect URL.\n"); return }
      busy = true
      const task = relay(callback, signal).then(status => {
        if (status !== 302 && status !== 204) write("The sign-in callback was rejected. Check the redirect URL or restart sign-in.\n")
      }).catch(() => {
        if (!signal.aborted) write("The sign-in callback could not complete. Retry sign-in.\n")
      }).finally(() => { busy = false; pending.delete(task) })
      pending.add(task)
    }, cancel)
    let printedUrl: string | undefined
    for await (const state of account.watch(signal)) {
      if (signal.aborted) break
      const attempt = state.attempt
      if (!attempt || attempt.id !== attemptId) continue
      if (attempt.authorizeUrl && attempt.authorizeUrl !== printedUrl) {
        printedUrl = attempt.authorizeUrl
        write(`Open this URL in your browser to sign in:\n${attempt.authorizeUrl}\n\n`)
        write("If the browser cannot reach the callback on this machine, copy its complete redirect URL and paste it here. Input is hidden. Press Ctrl+C to cancel.\n")
      }
      if (attempt.phase === "succeeded") { write("DeepSeek account sign-in completed.\n"); return true }
      if (attempt.phase === "cancelled") break
      if (attempt.phase === "expired" || attempt.phase === "failed") {
        write(attempt.phase === "expired" ? "DeepSeek sign-in expired. Try again.\n" : "DeepSeek sign-in failed. Try again.\n")
        return false
      }
    }
    write("DeepSeek sign-in cancelled.\n")
    return false
  } finally {
    stopInput?.()
    cancel()
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    if (attemptId) await account.cancelSignIn(attemptId)
    await Promise.allSettled(pending)
  }
}

interface CoordinatorInput {
  action: "options" | "decide"
  system?: string
  text?: string
  model?: string
  reasoningEffort?: string
  images?: { data: string; mimeType: string }[]
}
interface RouteInfo {
  id: string
  name: string
  context?: { contextWindow: number }
  inputModalities?: string[]
  reasoning?: { efforts: { id: string }[]; defaultEffort?: string }
}
interface InferenceServices {
  llm: {
    listProviders(): { id: string }[]
    listModels(provider: string): Promise<{ id: string }[]>
    resolveModelInfo(provider: string, model: string): Promise<RouteInfo>
    stream(input: object): AsyncIterable<{ type: string; text?: string; usage?: { totalTokens?: number; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }; reason?: { kind: string; failure?: { code?: string; status?: number } } }>
  }
  attachments: { saveImages(images: {data: Uint8Array; mediaType: string}[]): Promise<object[]> }
}

async function coordinate(ctx: InferenceServices, deepseek: string, preferred: { provider: string; model: string } | undefined, input: CoordinatorInput) {
  const providers = ctx.llm.listProviders()
  const discovered = await Promise.allSettled(providers.map(async ({ id: provider }) => {
    const models = await ctx.llm.listModels(provider)
    // Keep legacy bare IDs scoped to this registration's DeepSeek credential route.
    return models.map(({ id: model }) => ({ provider, model, id: provider === deepseek ? model : JSON.stringify([provider, model]) }))
  }))
  const routes = discovered.flatMap(group => group.status === "fulfilled" ? group.value : [])
  if (!routes.length) throw new Error("DSH_NO_MODELS")
  const fallback = routes.find(r => r.provider === preferred?.provider && r.model === preferred.model)
    ?? routes.find(r => r.provider === deepseek && r.model === "deepseek-flash") ?? routes[0]!
  if (input.action === "options") {
    const choices = await Promise.all(routes.map(async ({ id, provider, model }) => {
      const info = await ctx.llm.resolveModelInfo(provider, model)
      const name = provider === deepseek && providers.length === 1 ? info.name : provider + " / " + info.name
      return { id, name, reasoningEfforts: info.reasoning?.efforts.map(e => e.id) ?? [], defaultReasoningEffort: info.reasoning?.defaultEffort }
    }))
    return { models: choices, defaultModel: fallback.id, defaultReasoningEfforts: choices.find(m => m.id === fallback.id)!.reasoningEfforts }
  }
  if (input.action !== "decide" || !input.system || !input.text) throw new Error("Invalid DeepSeek coordinator request")
  const route = input.model === undefined ? fallback : routes.find(r => r.id === input.model)
  if (!route) throw new Error("DSH_MODEL_UNAVAILABLE")
  const { provider, model } = route
  const info = await ctx.llm.resolveModelInfo(provider, model)
  if (input.reasoningEffort && !info.reasoning?.efforts.some(e => e.id === input.reasoningEffort)) throw new Error("DSH_EFFORT_UNAVAILABLE")
  if (input.images?.length && !info.inputModalities?.includes("image")) throw new Error("DSH_IMAGE_UNSUPPORTED")
  const images = input.images?.length ? await ctx.attachments.saveImages(input.images.map(image => ({
    data: Buffer.from(image.data, "base64"), mediaType: image.mimeType,
  }))) : []
  const content = [{ type: "text", text: input.text }, ...images.map(attachment => ({ type: "image", attachment }))]
  let text = "", used: number | undefined, done = false
  for await (const part of ctx.llm.stream({ provider, model, reasoningEffort: input.reasoningEffort, system: input.system, messages: [{ role: "user", content }], tools: [] })) {
    if (part.type === "text-delta") {
      text += part.text ?? ""
      if (text.length > 1_000_000) throw new Error("DeepSeek routing result exceeds the limit")
    }
    if (part.type === "usage" && part.usage) {
      const u = part.usage
      used = u.totalTokens ?? u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
    }
    if (part.type === "finish") {
      if (part.reason?.kind !== "stop") {
        const failure = part.reason?.failure
        if (failure?.status === 401 || failure?.status === 403) throw new Error("DSH_AUTH")
        if (failure?.status === 429) throw new Error("DSH_QUOTA")
        throw new Error("DSH_MODEL_FAILURE")
      }
      done = true
    }
  }
  if (!done) throw new Error("DSH_MODEL_FAILURE")
  const value = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1")
  const decision: unknown = JSON.parse(value)
  return { decision, ...(Number.isSafeInteger(used) && used! >= 0 ? { usage: { used, size: info.context?.contextWindow } } : {}) }
}

async function coordinatorCommand(entryPoint: string): Promise<void> {
  const services = await createAccountServices(entryPoint, false, { inference: true })
  try {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      bytes += chunk.length
      if (bytes > 32 * 1024 * 1024) throw new Error("DeepSeek coordinator input exceeds the limit")
      chunks.push(Buffer.from(chunk))
    }
    const result = await services.coordinate!(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    process.stdout.write(JSON.stringify({ result }))
  } finally { await services.dispose() }
}

async function main(action: string, entryPoint: string): Promise<void> {
  if (action === "coordinate" && entryPoint) {
    try { await coordinatorCommand(entryPoint) }
    catch (error) {
      const code = error instanceof Error ? error.message : ""
      process.stdout.write(JSON.stringify({ error: /^DSH_(?:NO_MODELS|MODEL_UNAVAILABLE|EFFORT_UNAVAILABLE|IMAGE_UNSUPPORTED|AUTH|QUOTA|MODEL_FAILURE)$/.test(code) ? code : "DSH_MODEL_FAILURE" }))
    }
    return
  }
  if (!["status", "login", "acp"].includes(action) || !entryPoint) throw new Error("Invalid DeepSeek runtime helper command")
  // Capture the registration choice before the ACP launcher reads a workspace .env.
  const desktop = action === "acp" ? await readDesktopRoutes(entryPoint) : undefined
  let services: AccountServices | undefined
  let status: AccountStatus = { auth: "unknown" }
  let environment: unknown
  try {
    services = await createAccountServices(entryPoint, action === "login", { projectEnv: action === "acp" })
    environment = services.environment
    if (action === "login") {
      if (!await runAccountLogin(services)) process.exitCode = 1
      return
    }
    status = await accountStatus(services)
  } catch {
    if (action === "login") {
      process.stderr.write("DeepSeek account sign-in could not start. Retry sign-in or check the Harness configuration.\n")
      process.exitCode = 1
      return
    }
  } finally { await services?.dispose() }
  if (action === "status") { process.stdout.write(`${JSON.stringify(status)}\n`); return }
  // Reuse the same launch snapshot: loading .env twice would relabel file values as inherited.
  if (!environment) throw new Error("DeepSeek Harness credential environment could not be loaded")
  await runDesktopAcp(entryPoint, environment, acpPatchFiles(status), desktop!)
}

if (import.meta.main) await main(process.argv[2] ?? "", process.argv[3] ?? "")
