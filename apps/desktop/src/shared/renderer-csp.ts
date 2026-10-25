export const CSP_PLACEHOLDER = "__DESKFLEET_CONTENT_SECURITY_POLICY__"

export function rendererContentSecurityPolicy(production: boolean): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // User avatars come from Gravatar.
    "img-src 'self' data: https://gravatar.com",
    "font-src 'self'",
    "media-src 'self' blob:",
    // Vite's HMR client is the only development connection.
    production ? "connect-src 'none'" : "connect-src 'self' ws://127.0.0.1:5173",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ")
}

export function injectRendererContentSecurityPolicy(html: string, production: boolean): string {
  if (!html.includes(CSP_PLACEHOLDER)) {
    throw new Error("Renderer HTML is missing the CSP placeholder")
  }
  return html.replaceAll(CSP_PLACEHOLDER, rendererContentSecurityPolicy(production))
}
