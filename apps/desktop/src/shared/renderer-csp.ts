import { STATSIG_CONNECT_ORIGINS } from "@deskfleet/client/analytics-config"
import { parseSentryDsn } from "@deskfleet/client/sentry-config"

export const CSP_PLACEHOLDER = "__DESKFLEET_CONTENT_SECURITY_POLICY__"

export function rendererContentSecurityPolicy(production: boolean, statsigEnabled = false, sentryDsn?: string): string {
  const sentry = parseSentryDsn(sentryDsn)
  const connectSources = [
    "'self'",
    "blob:",
    "data:",
    ...(production ? [] : ["ws://127.0.0.1:5173"]),
    ...(statsigEnabled ? STATSIG_CONNECT_ORIGINS : []),
    ...(sentry ? [sentry.origin] : []),
  ]
  return [
    "default-src 'none'",
    // Terminal image decoders and Office previews compile bundled WebAssembly.
    "script-src 'self' 'wasm-unsafe-eval'",
    // Office parsers run in module Workers constructed from bundled source.
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    // User avatars come from Gravatar.
    "img-src 'self' data: blob: https://gravatar.com",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    // Fetch bundled WASM and in-memory previews; API traffic stays in main.
    `connect-src ${connectSources.join(" ")}`,
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ")
}

export function injectRendererContentSecurityPolicy(html: string, production: boolean, statsigEnabled = false, sentryDsn?: string): string {
  if (!html.includes(CSP_PLACEHOLDER)) {
    throw new Error("Renderer HTML is missing the CSP placeholder")
  }
  return html.replaceAll(CSP_PLACEHOLDER, rendererContentSecurityPolicy(production, statsigEnabled, sentryDsn))
}
