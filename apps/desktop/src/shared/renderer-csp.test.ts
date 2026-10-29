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

test("renderers may load images only from the app and Gravatar", () => {
  expect(injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, true)).toContain("img-src 'self' data: blob: https://gravatar.com;")
})

test("renderer HTML must declare the policy placeholder", () => {
  expect(() => injectRendererContentSecurityPolicy("<html></html>", true)).toThrow()
})
