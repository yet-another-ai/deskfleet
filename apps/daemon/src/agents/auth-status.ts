import type { AgentAuthStatus } from "@deskfleet/client/agent-live"

export const AUTH_STATUS_UPDATE_METHOD = "_auth/status_update"
const kinds = new Set(["account", "api_key", "gateway", "external", "none"])
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

/** Only identity display fields cross the daemon boundary; vendor payloads stay local. */
export function agentAuthStatus(params: unknown): AgentAuthStatus | undefined {
  if (!record(params) || !record(params.authStatus)) return undefined
  const status = params.authStatus
  if (typeof status.kind !== "string" || !kinds.has(status.kind) || typeof status.label !== "string") return undefined
  const details = record(status.account) ? status.account : undefined
  const account = details ? Object.fromEntries(["email", "organization", "plan"]
    .flatMap(key => typeof details[key] === "string" ? [[key, details[key]]] : [])) : undefined
  return { kind: status.kind as AgentAuthStatus["kind"], label: status.label,
    ...(typeof status.detail === "string" ? { detail: status.detail } : {}),
    ...(account && Object.keys(account).length ? { account } : {}),
  }
}
