import type { DeskfleetDesktopApi } from "../../../client/src/desktop-api.ts"
import type { PortForwardHost } from "../../../client/src/ports.ts"

export interface WebPreviewTarget {
  displayHost: PortForwardHost
  targetHost: PortForwardHost
  targetPort: number
  path: string
}

const VALID_HOSTS = new Set<PortForwardHost>(["localhost", "127.0.0.1", "::1"])

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
        displayHost: "localhost",
        targetHost: "localhost",
        targetPort: port,
        path: `${normalized.pathname}${normalized.search}${normalized.hash}`,
      }
    } catch {
      return null
    }
  }

  let candidate = trimmed
  const hasSchemeSeparator = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(trimmed)
  if (hasSchemeSeparator) {
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
    displayHost: host,
    targetHost: host,
    targetPort: port,
    path: `${parsed.pathname}${parsed.search}${parsed.hash}`,
  }
}

export function formatLogicalPreviewUrl(target: WebPreviewTarget): string {
  const host = target.displayHost === "::1" ? "[::1]" : target.displayHost
  const port = target.targetPort === 80 ? "" : `:${target.targetPort}`
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
    const host = target.displayHost === "::1" ? "[::1]" : target.displayHost
    return target.targetPort === 80 ? host : `${host}:${target.targetPort}`
  }
  return fallback
}

export function normalizeStoredWebPreviewTarget(raw: unknown): WebPreviewTarget | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (
    typeof record.displayHost !== "string"
    || typeof record.targetHost !== "string"
    || typeof record.targetPort !== "number"
    || typeof record.path !== "string"
  ) {
    return null
  }
  if (!VALID_HOSTS.has(record.displayHost as PortForwardHost) || !VALID_HOSTS.has(record.targetHost as PortForwardHost)) {
    return null
  }
  if (!isValidPort(record.targetPort)) return null
  try {
    const normalized = new URL(`http://localhost${record.path.startsWith("/") ? record.path : `/${record.path}`}`)
    return {
      displayHost: record.displayHost as PortForwardHost,
      targetHost: record.targetHost as PortForwardHost,
      targetPort: record.targetPort,
      path: `${normalized.pathname}${normalized.search}${normalized.hash}`,
    }
  } catch {
    return null
  }
}
