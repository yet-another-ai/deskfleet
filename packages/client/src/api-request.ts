import ky, { HTTPError, NetworkError, TimeoutError } from "ky"
import { isDesktopErrorReason } from "./desktop-media.ts"
import { attachRequestStack, CentralRequestError, HttpError, requestDiagnostics, type RequestTransport } from "./request-diagnostics.ts"

export const API_RETRY_STATUS_CODES = [408, 429, 500, 502, 503, 504] as const

export interface ApiRequestOptions {
  method?: string
  json?: unknown
  headers?: HeadersInit
  credentials?: RequestCredentials
  redirect?: RequestRedirect
  signal?: AbortSignal
  fetch?: typeof fetch
  transport?: RequestTransport
  timeoutMs?: number
  totalTimeoutMs?: number
  /** Writes require an explicit server-side idempotency guarantee before opting in. */
  idempotent?: boolean
  retryStatusCodes?: number[]
  /** Operation context for responses without an API error message. */
  errorPrefix?: string
}

function errorEnvelope(data: unknown): { message?: string; code?: string; reason?: string } {
  // Some gateways omit the JSON content type. Preserve their message, while
  // callers can still inspect the response headers before acting on an error code.
  if (typeof data === "string") {
    try { data = JSON.parse(data) }
    catch { return {} }
  }
  if (!data || typeof data !== "object") return {}
  const value = data as { message?: unknown; error?: unknown }
  const nested = value.error && typeof value.error === "object" ? value.error as { message?: unknown; code?: unknown; reason?: unknown } : undefined
  const message = value.message ?? (typeof value.error === "string" ? value.error : nested?.message)
  return {
    ...(typeof message === "string" ? { message } : {}),
    ...(typeof nested?.code === "string" ? { code: nested.code } : {}),
    ...(typeof nested?.reason === "string" ? { reason: nested.reason } : {}),
  }
}

/** Shared JSON API transport for Web, Electron, daemon, and the MCP gateway. */
export async function apiRequest<T>(url: string, options: ApiRequestOptions = {}): Promise<T> {
  const requestStack = new Error().stack
  const method = (options.method ?? "GET").toUpperCase()
  const read = ["GET", "HEAD"].includes(method)
  const idempotent = options.idempotent ?? read
  // Backend RPCs and peer negotiation may take 60 seconds. Their transport
  // deadline leaves room for the server's structured timeout response. Retry
  // eligibility does not change the operation's timeout budget.
  const timeout = options.timeoutMs ?? (read ? 5_000 : 65_000)
  const totalTimeout = options.totalTimeoutMs ?? (read ? 15_000 : 65_000)
  const path = new URL(url).pathname
  const started = performance.now()
  let phase: "fetch" | "response_body" = "fetch"
  let status: number | undefined
  const details = () => ({ method, path, body: options.json, signal: options.signal, transport: options.transport,
    elapsedMs: performance.now() - started, phase, ...(status === undefined ? {} : { status }) })
  try {
    return await ky(url, {
      method, json: options.json, headers: options.headers,
      credentials: options.credentials, redirect: options.redirect,
      signal: options.signal, fetch: options.fetch,
      timeout, totalTimeout,
      retry: {
        limit: idempotent ? 2 : 0,
        methods: [method.toLowerCase()],
        statusCodes: options.retryStatusCodes ?? [...API_RETRY_STATUS_CODES],
        retryOnTimeout: true,
      },
      parseJson: (text, { response }) => response.status === 204 || method === "HEAD" ? undefined : JSON.parse(text),
      hooks: {
        beforeRetry: [() => { phase = "fetch"; status = undefined }],
        afterResponse: [({ response }) => { phase = "response_body"; status = response.status }],
      },
    }).json<T>()
  } catch (error) {
    if (error instanceof HTTPError) {
      const response = error.response
      const envelope = errorEnvelope(error.data)
      const message = envelope.message || (options.errorPrefix ? `${options.errorPrefix} (${response.status})` : response.statusText || `HTTP ${response.status}`)
      throw attachRequestStack(new HttpError(response.status, message,
        isDesktopErrorReason(envelope.reason) ? envelope.reason : undefined, envelope.code,
        requestDiagnostics(undefined, { ...details(), kind: "http", phase: "response_body", status: response.status }),
        { cause: error, response }), requestStack)
    }
    // Ky's network/timeout messages include the full URL. Keep the original
    // network cause and expose a URL-free timeout message across IPC/reporting.
    const cause = error instanceof NetworkError ? error.cause : error
    const message = error instanceof TimeoutError ? "The request timed out" : cause instanceof Error ? cause.message : "API request failed"
    throw attachRequestStack(new CentralRequestError(message, requestDiagnostics(cause, details()), { cause }), requestStack)
  }
}
