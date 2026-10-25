import { expect, test } from "vitest"
import { CSP_PLACEHOLDER, injectRendererContentSecurityPolicy } from "./renderer-csp.ts"

test("production renderers cannot open network connections", () => {
  const html = injectRendererContentSecurityPolicy(`<meta content="${CSP_PLACEHOLDER}">`, true)
  expect(html).toContain("connect-src 'none'")
  expect(html).not.toContain(CSP_PLACEHOLDER)
})

test("development renderers may reach only the Vite HMR socket", () => {
  const html = injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, false)
  expect(html).toContain("connect-src 'self' ws://127.0.0.1:5173")
})

test("renderers may load images only from the app and Gravatar", () => {
  expect(injectRendererContentSecurityPolicy(CSP_PLACEHOLDER, true)).toContain("img-src 'self' data: blob: https://gravatar.com;")
})

test("renderer HTML must declare the policy placeholder", () => {
  expect(() => injectRendererContentSecurityPolicy("<html></html>", true)).toThrow()
})
