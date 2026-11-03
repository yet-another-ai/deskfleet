import type { Event, EventHint } from "@sentry/vue"
import { CentralRequestError, type CentralRequestDiagnostics } from "@deskfleet/client/request-diagnostics"

function failureIdentity({ causes, kind, status }: CentralRequestDiagnostics) {
  const codes = [...new Set(causes.flatMap(cause => cause.code ? [cause.code] : []))].sort()
  return { codes, failure: kind === "http" ? `HTTP ${status}` : codes.join(",") || kind }
}

export function centralRequestFingerprint(diagnostics: CentralRequestDiagnostics): string[] {
  const { transport, method, route, rpcMethod, kind, phase } = diagnostics
  return ["central-request", transport, method, route, rpcMethod ?? "", kind, phase, failureIdentity(diagnostics).failure]
}

export function prepareCentralRequest(event: Event, hint: EventHint): Event | null {
  const error = hint.originalException
  if (!(error instanceof CentralRequestError)) return event
  const { method, route, rpcMethod, elapsedMs, causes, kind, phase, status, transport, trigger = "unknown", online, visibility } = error.diagnostics
  if (kind === "cancelled") return null
  const { codes, failure } = failureIdentity(error.diagnostics)
  const exception = event.exception?.values?.at(-1)
  if (exception) {
    // Change the report, not the Error that the UI receives.
    exception.type = "CentralRequestError"
    exception.value = `${method} ${route}${rpcMethod ? ` (${rpcMethod})` : ""} — ${failure}`
  }
  // Generated stacks differ between platform builds; group by operation/cause.
  event.fingerprint = centralRequestFingerprint(error.diagnostics)
  event.tags = { ...event.tags,
    "central.transport": transport, "central.method": method, "central.route": route,
    "central.failure_kind": kind, "central.phase": phase, "central.trigger": trigger,
    ...(status !== undefined ? { "central.status": String(status) } : {}),
    ...(rpcMethod ? { "central.rpc_method": rpcMethod } : {}),
    ...(codes[0] ? { "central.cause_code": codes[0] } : {}),
    ...(online !== undefined ? { "central.online": String(online) } : {}),
    ...(visibility ? { "central.visibility": visibility } : {}),
  }
  event.contexts = { ...event.contexts, central_request: {
    method, route, rpc_method: rpcMethod, elapsed_ms: elapsedMs, transport, kind, phase, status, trigger, online, visibility,
    causes: causes.map(cause => [cause.name, cause.code, cause.syscall].filter(Boolean).join(": ")),
  } }
  return event
}
