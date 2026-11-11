export const NETWORK_DIAGNOSTICS_CHANNEL = "deskfleet:network-diagnostics"

export type NatBehavior = "unknown" | "endpoint-independent" | "address-dependent" | "address-and-port-dependent"

/** A point-in-time observation of the local client's IPv4 UDP path to one STUN server. */
export interface NatTestResult {
  /** The resolved IPv4 STUN endpoint used by the probe. */
  server: string
  localAddress: string
  publicAddress?: string | null
  mapping: NatBehavior | "direct"
  filtering: NatBehavior
  status: "complete" | "server-unsupported" | "inconclusive" | "udp-unreachable"
  durationMs: number
}

/** Client-owned diagnostics; probes stay local and results are never sent to the backend. */
export interface NetworkDiagnosticsApi {
  /** Probe the current DeskFleet service's configured STUN server. */
  testNat(): Promise<NatTestResult>
}

/** Preserve deployment order and use only endpoints compatible with the IPv4 UDP probe. */
export function stunEndpoint(urls: readonly string[]): string | undefined {
  for (const url of urls) {
    const match = /^stun:([a-z0-9.-]+)(?::([0-9]+))?(?:\?transport=udp)?$/i.exec(url)
    if (!match || match[1]!.length > 253) continue
    const port = match[2] === undefined ? 3478 : Number(match[2])
    if (port > 0 && port <= 65535) return `${match[1]}:${port}`
  }
}
