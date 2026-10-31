export interface CentralRequestDiagnostics {
  method: string
  route: string
  rpcMethod?: string
  elapsedMs: number
  causes: Array<{ name: string; code?: string }>
}

export interface SerializedCentralRequestError {
  name: string
  message: string
  stack?: string
  diagnostics: CentralRequestDiagnostics
}

// Only route templates leave the transport; unmatched paths carry no segments.
const routes = [
  "/api/me", "/api/site", "/api/teams", "/api/invites/accept", "/api/integrations/github", "/api/integrations/github/pull-request",
  "/api/auth/config", "/api/auth/start", "/api/auth/exchange", "/api/auth/logout", "/api/auth/register",
  "/api/auth/registration", "/api/auth/reauthenticate",
  "/api/auth/reauthenticate/methods", "/api/auth/reauthenticate/email", "/api/auth/reauthenticate/email/verify",
  "/api/auth/passkeys/login", "/api/auth/passkeys/login/options",
  "/api/auth/passkeys/reauthenticate", "/api/auth/passkeys/reauthenticate/options",
  "/api/auth/passkeys/register", "/api/auth/passkeys/register/options",
  "/api/admin/site-settings", "/api/admin/users", "/api/admin/users/:userId/disabled",
  "/api/admin/teams", "/api/admin/teams/:teamId/enterprise",
  "/api/teams/:teamId", "/api/teams/:teamId/billing", "/api/teams/:teamId/billing/checkout",
  "/api/teams/:teamId/billing/portal", "/api/teams/:teamId/machines", "/api/teams/:teamId/members",
  "/api/teams/:teamId/members/:userId", "/api/teams/:teamId/usage", "/api/teams/:teamId/ai-usage",
  "/api/teams/:teamId/ai-usage/sessions", "/api/teams/:teamId/invites", "/api/teams/:teamId/ownership",
  "/api/teams/:teamId/search", "/api/machines/:machineId/schedules",
  "/api/machines/:machineId", "/api/machines/:machineId/catalog", "/api/machines/:machineId/sessions",
  "/api/machines/:machineId/sessions/:sessionId", "/api/machines/:machineId/sessions/:sessionId/events",
  "/api/machines/:machineId/rpc", "/api/peers", "/api/peers/local", "/api/peers/:peerId",
  "/api/peers/:peerId/offer", "/api/peers/:peerId/start", "/api/peers/:peerId/candidate",
].map(route => ({ route, pattern: new RegExp(`^${route.replace(/:[A-Za-z]+/gu, "[^/]+")}$`, "u") }))

const rpcMethods = new Set([
  "_deskfleet/agent/configuration", "_deskfleet/session/configuration", "_deskfleet/session/configure",
  "_deskfleet/session/create", "_deskfleet/session/fork", "_deskfleet/session/archive", "_deskfleet/session/restore",
  "_deskfleet/session/rename", "_deskfleet/session/delete", "_deskfleet/session/read", "_deskfleet/session/list",
  "_deskfleet/session/subscribe", "_deskfleet/session/history", "_deskfleet/command/get", "_deskfleet/git/branches",
  "catalogList", "workspaceCreate", "workspaceUpdate", "workspaceDelete", "directoryList",
  "providerList", "providerCreate", "providerUpdate", "providerRemove", "providerTest", "providerProbe", "providerInstall", "providerLogin",
  "capabilities", "systemStatus", "terminalList", "terminalDial", "terminalHangup",
  "scheduleList", "scheduleCreate", "scheduleUpdate", "scheduleDelete", "scheduleRun",
  "mcpServerList", "mcpServerCreate", "mcpServerUpdate", "mcpServerRemove",
])
const errorNames = new Set([
  "Error", "TypeError", "AggregateError", "AbortError", "TimeoutError", "SocketError",
  "ConnectTimeoutError", "HeadersTimeoutError", "BodyTimeoutError", "RequestAbortedError",
])
const errorCodes = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "EACCES", "EPERM",
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_GET_ISSUER_CERT",
  "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE", "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT",
  "UND_ERR_DESTROYED", "UND_ERR_ABORTED",
])

function errorName(value: unknown): string {
  return typeof value === "string" && errorNames.has(value) ? value : "Error"
}

function causesOf(error: unknown): CentralRequestDiagnostics["causes"] {
  const pending = [error]
  const seen = new Set<unknown>()
  const causes: CentralRequestDiagnostics["causes"] = []
  while (pending.length && causes.length < 8) {
    const next = pending.shift()
    if (!next || typeof next !== "object" || seen.has(next)) continue
    seen.add(next)
    const value = next as { name?: unknown; code?: unknown; cause?: unknown }
    const code = typeof value.code === "string" && errorCodes.has(value.code) ? value.code : undefined
    causes.push({ name: errorName(value.name), ...(code && { code }) })
    if (value.cause) pending.push(value.cause)
    if (next instanceof AggregateError) pending.push(...next.errors.slice(0, 8))
  }
  return causes
}

/** A failed central fetch retains its local cause and an IPC-safe diagnostic summary. */
export class CentralRequestError extends Error {
  readonly diagnostics: CentralRequestDiagnostics
  constructor(message: string, diagnostics: CentralRequestDiagnostics, options?: ErrorOptions) {
    super(message, options)
    this.name = errorName(options?.cause instanceof Error ? options.cause.name : undefined)
    this.diagnostics = diagnostics
  }
}

export function centralRequestFailure(
  cause: unknown,
  request: { method: string; path: string; body?: unknown; elapsedMs: number },
  requestStack?: string,
): CentralRequestError {
  const path = request.path.split(/[?#]/u, 1)[0]!
  const route = routes.find(candidate => candidate.pattern.test(path))?.route ?? "unknown"
  const body = request.body && typeof request.body === "object" ? request.body as { method?: unknown } : undefined
  const rpcMethod = route === "/api/machines/:machineId/rpc" && typeof body?.method === "string" && rpcMethods.has(body.method) ? body.method : undefined
  const error = new CentralRequestError(cause instanceof Error ? cause.message : "fetch failed", {
    method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method) ? request.method : "unknown",
    route, ...(rpcMethod && { rpcMethod }), elapsedMs: Math.max(0, Math.round(request.elapsedMs)), causes: causesOf(cause),
  }, { cause })
  // Undici can omit its stack entirely; retain the caller captured before await.
  if (requestStack) error.stack = `${error.name}: ${error.message}\n${requestStack.split("\n").slice(1).join("\n")}`
  return error
}

export function serializeCentralRequestError(error: unknown): SerializedCentralRequestError | undefined {
  if (!(error instanceof CentralRequestError)) return undefined
  // Main-process stacks include user-specific installation directories. Keep
  // bundle names and source coordinates, without sending those local paths.
  const stack = error.stack?.replace(
    /^(\s*at (?:async )?(?:.*? \()?)(?:file:\/\/|[A-Za-z]:[\\/]|\/)(.*?)(:\d+(?::\d+)?\)?\s*)$/gmu,
    (_frame, prefix: string, path: string, suffix: string) => `${prefix}app:///${path.split(/[\\/]/u).at(-1)}${suffix}`,
  )
  return { name: error.name, message: error.message, stack, diagnostics: structuredClone(error.diagnostics) }
}

export function deserializeCentralRequestError(value: SerializedCentralRequestError): CentralRequestError {
  const error = new CentralRequestError(value.message, structuredClone(value.diagnostics))
  error.name = value.name
  error.stack = value.stack
  return error
}
