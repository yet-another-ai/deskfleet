import type { PeerGrant } from "./central.ts"
import type { RelayDeniedReason } from "./relay.ts"

export type PeerFeature = "agent" | "terminal" | "desktop" | "files" | "ports"
export type PeerRelayAccess = "allowed" | "unconfigured" | RelayDeniedReason
export interface PeerTelemetryEvents {
  peer_granted: { feature: PeerFeature; relay: PeerRelayAccess }
  peer_connection: { feature: PeerFeature; relay: PeerRelayAccess; outcome: "connected" | "failed"; transport: "unknown" }
}
export type PeerTelemetryEvent = {
  /** Internal correlation only; analytics receives metadata after matching the active Team. */
  [Name in keyof PeerTelemetryEvents]: { name: Name; teamId: string; metadata: PeerTelemetryEvents[Name] }
}[keyof PeerTelemetryEvents]
export type PeerTelemetrySink = (event: PeerTelemetryEvent) => void

let sink: PeerTelemetrySink | undefined

/** Hosts opt in; the client library itself has no analytics service dependency. */
export function setPeerTelemetrySink(value: PeerTelemetrySink | undefined): () => void {
  sink = value
  return () => { if (sink === value) sink = undefined }
}

function emit(event: PeerTelemetryEvent): void {
  // Observability must never affect authorization or a live connection.
  try { sink?.(event) } catch {}
}

export interface PeerConnectionTelemetry { connected(): void; failed(): void }

/** Relay credentials describe available fallback, never the selected ICE path. */
export function observePeerGrant(feature: PeerFeature, grant: Pick<PeerGrant, "iceServers" | "relayDeniedReason">, teamId: string): PeerConnectionTelemetry {
  const reason = grant.relayDeniedReason
  const denied = reason === "free_plan" || reason === "turn_quota_exhausted" || reason === "metering_unavailable" ? reason : undefined
  const relay: PeerRelayAccess = denied ?? (grant.iceServers.some(server =>
    (typeof server.urls === "string" ? [server.urls] : server.urls).some(url => /^turns?:/iu.test(url)),
  ) ? "allowed" : "unconfigured")
  emit({ name: "peer_granted", teamId, metadata: { feature, relay } })
  let settled = false
  function outcome(value: "connected" | "failed"): void {
    if (settled) return
    settled = true
    emit({ name: "peer_connection", teamId, metadata: { feature, relay, outcome: value, transport: "unknown" } })
  }
  return { connected: () => outcome("connected"), failed: () => outcome("failed") }
}
