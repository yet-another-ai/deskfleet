import type { DeskfleetDesktopApi } from "../../../client/src/desktop-api.ts"
import type { PortForwardHost } from "../../../client/src/ports.ts"

export interface WebPreviewTarget {
  host: PortForwardHost
  port: number
  path: string
}

export function isWebPreviewSupported(
  client: Pick<DeskfleetDesktopApi, "platform" | "mobile" | "ports">,
): boolean {
  return client.platform !== "web" || (Boolean(client.mobile) && Boolean(client.ports))
}

function normalizeHost(hostname: string): PortForwardHost | null {
  const lower = hostname.toLowerCase()
  if (lower === "localhost") return "localhost"
  if (lower === "127.0.0.1") return "127.0.0.1"
  if (lower === "[::1]" || lower === "::1") return "::1"
  return null
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/** Parses a loopback port shorthand (`5173`, `:5173/docs`) or HTTP loopback URL. */
export function parseWebPreviewInput(raw: string): WebPreviewTarget | null {
  if (typeof raw !== "string" || raw.includes("\0")) return null
  const trimmed = raw.trim()
  if (!trimmed || /\s/u.test(trimmed)) return null

  const portShorthand = trimmed.match(/^:?(\d{1,5})([/?#].*)?$/u)
  if (portShorthand) {
    const port = Number(portShorthand[1])
    if (!isValidPort(port)) return null
    const suffix = portShorthand[2] ?? "/"
    try {
      const normalized = new URL(`http://localhost:${port}${suffix.startsWith("/") ? suffix : `/${suffix}`}`)
      return {
        host: "localhost",
        port,
        path: `${normalized.pathname}${normalized.search}${normalized.hash}`,
      }
    } catch {
      return null
    }
  }

  let candidate = trimmed
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(trimmed)) {
    if (!/^http:\/\//iu.test(trimmed)) return null
  } else {
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/u.test(trimmed) && !/^localhost(?::|$)/iu.test(trimmed)) {
      return null
    }
    candidate = `http://${trimmed}`
  }

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
  if (!isValidPort(port)) return null

  return {
    host,
    port,
    path: `${parsed.pathname}${parsed.search}${parsed.hash}`,
  }
}

export function formatLogicalPreviewUrl(target: WebPreviewTarget): string {
  const host = target.host === "::1" ? "[::1]" : target.host
  const port = target.port === 80 ? "" : `:${target.port}`
  const path = target.path && target.path !== "/"
    ? (target.path.startsWith("/") ? target.path : `/${target.path}`)
    : ""
  return `http://${host}${port}${path}`
}

export function buildActualPreviewOrigin(host: PortForwardHost, port: number): string {
  const formattedHost = host === "::1" ? "[::1]" : host
  return new URL(`http://${formattedHost}:${port}`).origin
}

export function buildActualPreviewUrl(origin: string, path = "/"): string {
  const normalizedPath = path ? (path.startsWith("/") ? path : `/${path}`) : "/"
  return `${origin}${normalizedPath}`
}

export function extractLogicalPath(actualUrl: string, expectedOrigin: string): string | null {
  try {
    const parsed = new URL(actualUrl)
    if (parsed.origin !== expectedOrigin) return null
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return null
  }
}

export function formatWebPreviewTabTitle(
  target?: WebPreviewTarget | null,
  pageTitle?: string,
  fallback = "Web Preview",
): string {
  const trimmedTitle = pageTitle?.trim()
  if (trimmedTitle && !/^(?:https?:\/\/)?127\.0\.0\.1:\d+(?:\/.*)?$/iu.test(trimmedTitle)) {
    return trimmedTitle
  }
  if (target) {
    const host = target.host === "::1" ? "[::1]" : target.host
    return target.port === 80 ? host : `${host}:${target.port}`
  }
  return fallback
}
