import { expect, test } from "vitest"
import { CSP_PLACEHOLDER, injectRendererContentSecurityPolicy } from "./renderer-csp.ts"

test("production renderers without analytics cannot open network connections", () => {
  const html = injectRendererContentSecurityPolicy(`<meta content="${CSP_PLACEHOLDER}">`, true)
  expect(html).toContain("connect-src 'none'")
  expect(html).not.toContain(CSP_PLACEHOLDER)
})

test("terminal image decoders may compile WebAssembly without allowing JavaScript eval", () => {
  const policy = injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, true)
  expect(policy.split("; ").find(directive => directive.startsWith("script-src ")))
    .toBe("script-src 'self' 'wasm-unsafe-eval'")
})

test("development renderers may reach only the Vite HMR socket", () => {
  const html = injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, false)
  expect(html).toContain("connect-src 'self' ws://127.0.0.1:5173")
})

test("configured production renderers may reach only the Statsig endpoints", () => {
  const html = injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, true, true)
  expect(html).toContain("connect-src https://featureassets.org https://prodregistryv2.org https://statsigapi.net;")
})

test("configured development renderers keep HMR alongside Statsig", () => {
  const html = injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, false, true)
  expect(html).toContain("connect-src 'self' ws://127.0.0.1:5173 https://featureassets.org https://prodregistryv2.org https://statsigapi.net;")
})

test("Sentry permits only its configured DSN origin without credentials or a wildcard", () => {
  const html = injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, true, false, "https://publickey@o123.ingest.sentry.io/456")
  expect(html).toContain("connect-src https://o123.ingest.sentry.io;")
  expect(html).not.toContain("publickey")
  expect(html).not.toContain("*.sentry.io")
})

test("self-hosted Sentry coexists with Statsig and development HMR", () => {
  const html = injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, false, true, "http://publickey@sentry.example.com:9000/prefix/42")
  expect(html).toContain("connect-src 'self' ws://127.0.0.1:5173 https://featureassets.org https://prodregistryv2.org https://statsigapi.net http://sentry.example.com:9000;")
})

test.each(["", " ", "not-a-dsn", "https://publickey@*.example.com/1", "https://sentry.example.com/1"])("invalid Sentry DSN keeps production networking disabled: %s", dsn => {
  expect(injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, true, false, dsn)).toContain("connect-src 'none'")
})

test("renderers may load images only from the app and Gravatar", () => {
  expect(injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, true)).toContain("img-src 'self' data: blob: https://gravatar.com;")
})

test("renderer HTML must declare the policy placeholder", () => {
  expect(() => injectRendererContentSecurityPolicy("<html></html>", true)).toThrow()
})
