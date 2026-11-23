import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import type { PortForwardHost } from "@deskfleet/client/ports"

export interface WebPreviewTarget {
  host: PortForwardHost
  port: number
  path: string
}

export function isWebPreviewSupported(
  client: Pick<DeskfleetDesktopApi, "platform">,
): boolean {
  return client.platform !== "web"
}

function normalizeHost(hostname: string): PortForwardHost | null {
  const lower = hostname.toLowerCase()
  if (lower === "localhost") return "localhost"
  if (lower === "127.0.0.1") return "127.0.0.1"
  if (lower === "[::1]" || lower === "::1") return "::1"
  return null
}

function formatLoopbackHostPort(host: PortForwardHost, port: number): string {
  const formattedHost = host === "::1" ? "[::1]" : host
  return port === 80 ? formattedHost : `${formattedHost}:${port}`
}

/** Parses a loopback port shorthand (`5173`, `:5173/docs`) or HTTP loopback URL. */
export function parseWebPreviewInput(raw: string): WebPreviewTarget | null {
  if (typeof raw !== "string" || raw.includes("\0")) return null
  const trimmed = raw.trim()
  if (!trimmed || /\s/u.test(trimmed)) return null

  const shorthand = trimmed.match(/^:?(\d{1,5})([/?#].*)?$/u)
  const candidate = shorthand
    ? `http://localhost:${shorthand[1]}${!shorthand[2] || shorthand[2].startsWith("/") ? (shorthand[2] ?? "/") : `/${shorthand[2]}`}`
    : /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(trimmed)
      ? trimmed
      : /^(?:localhost|127\.0\.0\.1|\[::1\])(?=$|[:/?#])/iu.test(trimmed)
        ? `http://${trimmed}`
        : ""
  if (!candidate) return null

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }
  if (parsed.protocol !== "http:" || parsed.username !== "" || parsed.password !== "") return null
  const host = normalizeHost(parsed.hostname)
  if (!host) return null

  const port = parsed.port === "" ? 80 : Number(parsed.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null

  return {
    host,
    port,
    path: `${parsed.pathname}${parsed.search}${parsed.hash}`,
  }
}

export function normalizeWebPreviewUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const parsed = parseWebPreviewInput(raw)
  return parsed ? formatWebPreviewUrl(parsed) : null
}

export function formatWebPreviewUrl(target: WebPreviewTarget, includeRootSlash = false): string {
  const path = target.path && (includeRootSlash || target.path !== "/")
    ? (target.path.startsWith("/") ? target.path : `/${target.path}`)
    : ""
  return `http://${formatLoopbackHostPort(target.host, target.port)}${path}`
}

export function formatWebPreviewTabTitle(
  target?: WebPreviewTarget | string | null,
  fallback = "Web Preview",
): string {
  const resolved = typeof target === "string" ? parseWebPreviewInput(target) : target
  return resolved ? formatLoopbackHostPort(resolved.host, resolved.port) : fallback
}
