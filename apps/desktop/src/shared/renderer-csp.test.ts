import { expect, test } from "vitest"
import { CSP_PLACEHOLDER, injectRendererContentSecurityPolicy } from "./renderer-csp.ts"

test("production renderers without analytics may fetch bundled and in-memory resources", () => {
  const html = injectRendererContentSecurityPolicy(`<meta content="${CSP_PLACEHOLDER}">`, true)
  expect(html).toContain("connect-src 'self' blob: data:;")
  expect(html).not.toContain(CSP_PLACEHOLDER)
})

test("terminal image decoders and Office previews may compile WebAssembly without allowing JavaScript eval", () => {
  const policy = injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, true)
  expect(policy.split("; ").find(directive => directive.startsWith("script-src ")))
    .toBe("script-src 'self' 'wasm-unsafe-eval'")
})

test.each([true, false])("Office previews may start only app and Blob workers (production: %s)", production => {
  const policy = injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, production)
  expect(policy.split("; ").find(directive => directive.startsWith("worker-src ")))
    .toBe("worker-src 'self' blob:")
})

test.each([true, false])("renderers allow bundled and embedded fonts (production: %s)", (production) => {
  const policy = injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, production)
  expect(policy.split("; ").find(directive => directive.startsWith("font-src ")))
    .toBe("font-src 'self' data:")
})

test("development renderers may reach only the Vite HMR socket", () => {
  const html = injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, false)
  expect(html).toContain("connect-src 'self' blob: data: ws://127.0.0.1:5173")
})

test("configured production renderers may fetch app assets and reach only the Statsig endpoints", () => {
  const html = injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, true, true)
  expect(html).toContain("connect-src 'self' blob: data: https://featureassets.org https://prodregistryv2.org https://statsigapi.net;")
})

test("configured development renderers keep HMR alongside Statsig", () => {
  const html = injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, false, true)
  expect(html).toContain("connect-src 'self' blob: data: ws://127.0.0.1:5173 https://featureassets.org https://prodregistryv2.org https://statsigapi.net;")
})

test("Sentry permits only its configured DSN origin without credentials or a wildcard", () => {
  const html = injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, true, false, "https://publickey@o123.ingest.sentry.io/456")
  expect(html).toContain("connect-src 'self' blob: data: https://o123.ingest.sentry.io;")
  expect(html).not.toContain("publickey")
  expect(html).not.toContain("*.sentry.io")
})

test("self-hosted Sentry coexists with Statsig and development HMR", () => {
  const html = injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, false, true, "http://publickey@sentry.example.com:9000/prefix/42")
  expect(html).toContain("connect-src 'self' blob: data: ws://127.0.0.1:5173 https://featureassets.org https://prodregistryv2.org https://statsigapi.net http://sentry.example.com:9000;")
})

test.each(["", " ", "not-a-dsn", "https://publickey@*.example.com/1", "https://sentry.example.com/1"])("invalid Sentry DSN keeps production connections limited to local resources: %s", dsn => {
  expect(injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, true, false, dsn)).toContain("connect-src 'self' blob: data:;")
})

test("renderers may load images only from the app and Gravatar", () => {
  expect(injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, true)).toContain("img-src 'self' data: blob: https://gravatar.com;")
})

test("production renderers do not open connect-src for Gravatar avatar probes", () => {
  const connect = injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, true)
    .split("; ")
    .find(directive => directive.startsWith("connect-src "))
  expect(connect).toBe("connect-src 'self' blob: data:")
})

test("renderer HTML must declare the policy placeholder", () => {
  expect(() => injectRendererContentSecurityPolicy("<html></html>", true)).toThrow()
})
