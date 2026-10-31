import type { RelayDeniedReason } from "@deskfleet/client/relay"

export type ErrorKind = "generic" | "network" | "unauthorized" | "forbidden" | "notFound" | "rateLimited" | "server" | "machineOffline" | RelayDeniedReason
export interface ErrorPresentation {
  kind: ErrorKind
  detail?: string
  billing: boolean
}

function errorDetail(error: unknown): string | undefined {
  if (error == null) return undefined
  if (typeof error === "string") return error.trim() || undefined
  if (typeof error === "object" && "message" in error && typeof error.message === "string") return error.message.trim() || undefined
  try { return JSON.stringify(error, null, 2) }
  catch { return String(error) }
}

function relayReason(value: unknown): RelayDeniedReason | undefined {
  return value === "free_plan" || value === "turn_quota_exhausted" || value === "metering_unavailable" ? value : undefined
}

/** Keep presentation separate from the error itself, including codes retained across host bridges. */
export function errorPresentation(error: unknown, relayDeniedReason?: RelayDeniedReason): ErrorPresentation {
  const fields = typeof error === "object" && error !== null ? error as { code?: unknown; status?: unknown; relayDeniedReason?: unknown } : undefined
  const relay = relayDeniedReason ?? relayReason(fields?.relayDeniedReason) ?? relayReason(fields?.code)
  const detail = errorDetail(error)
  let kind: ErrorKind = relay ?? "generic"
  if (!relay) {
    if (fields?.code === "machine_offline") kind = "machineOffline"
    else if (fields?.status === 401 || fields?.code === "unauthorized") kind = "unauthorized"
    else if (fields?.status === 403 || fields?.code === "forbidden") kind = "forbidden"
    else if (fields?.status === 404 || fields?.code === "not_found") kind = "notFound"
    else if (fields?.status === 429) kind = "rateLimited"
    else if (typeof fields?.status === "number" && fields.status >= 500) kind = "server"
    else if (detail && ["Failed to fetch", "fetch failed", "NetworkError when attempting to fetch resource.", "Load failed"].includes(detail)) kind = "network"
  }
  return { kind, detail, billing: relay === "free_plan" || relay === "turn_quota_exhausted" }
}
