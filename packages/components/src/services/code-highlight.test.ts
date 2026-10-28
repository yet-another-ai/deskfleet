import { expect, test, vi } from "vitest"
import { highlightCode } from "./code-highlight.ts"

test("highlights a known language with dual-theme CSS variables", async () => {
  const html = await highlightCode("const value = 1", "typescript")
  expect(html).toBeDefined()
  expect(html).toContain("shiki")
  expect(html).toContain("--shiki-light")
  expect(html).toContain("--shiki-dark")
  expect(html).toContain("const")
  expect(html).toContain("value")
})

test("falls back to plaintext for unknown languages", async () => {
  const html = await highlightCode("hello world", "not-a-real-language")
  expect(html).toBeDefined()
  expect(html).toContain("hello world")
  expect(html).toContain("shiki")
})

test("returns undefined when codeToHtml rejects", async () => {
  vi.resetModules()
  vi.doMock("shiki", () => ({
    bundledLanguages: { python: {} },
    codeToHtml: async () => { throw new Error("unavailable") },
  }))
  const { highlightCode: highlight } = await import("./code-highlight.ts")
  await expect(highlight("x = 1", "python")).resolves.toBeUndefined()
  vi.doUnmock("shiki")
  vi.resetModules()
})
