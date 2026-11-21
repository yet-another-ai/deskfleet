import { expect, test } from "vitest"
import {
  formatWebPreviewTabTitle,
  formatWebPreviewUrl,
  isWebPreviewSupported,
  normalizeWebPreviewUrl,
  parseWebPreviewInput,
} from "./web-preview.ts"

test("parses port shorthands and loopback URLs while rejecting non-loopback or non-HTTP inputs", () => {
  expect(parseWebPreviewInput("5173")).toEqual({ host: "localhost", port: 5173, path: "/" })
  expect(parseWebPreviewInput(":3000/docs?tab=1#top")).toEqual({ host: "localhost", port: 3000, path: "/docs?tab=1#top" })
  expect(parseWebPreviewInput("localhost:4321/app")).toEqual({ host: "localhost", port: 4321, path: "/app" })
  expect(parseWebPreviewInput("http://127.0.0.1:8080/api")).toEqual({ host: "127.0.0.1", port: 8080, path: "/api" })
  expect(parseWebPreviewInput("http://[::1]:9000/metrics")).toEqual({ host: "::1", port: 9000, path: "/metrics" })
  expect(parseWebPreviewInput("http://localhost")).toEqual({ host: "localhost", port: 80, path: "/" })

  for (const invalid of [
    "",
    "   ",
    "0",
    "65536",
    "https://localhost:5173",
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///tmp/index.html",
    "http://user:pass@localhost:5173",
    "example.com:3000",
    "http://192.168.1.2:3000",
    "http://127.0.0.2:3000",
    "http://0.0.0.0:3000",
    "http://localhost:5173\0",
  ]) {
    expect(parseWebPreviewInput(invalid)).toBeNull()
  }
})

test("formats URLs, normalizes stored URLs, formats tab titles, and gates platforms", () => {
  const target = parseWebPreviewInput("localhost:5173/dashboard?a=1")!
  const root = parseWebPreviewInput("5173")!
  expect(formatWebPreviewUrl(target)).toBe("http://localhost:5173/dashboard?a=1")
  expect(formatWebPreviewUrl(root)).toBe("http://localhost:5173")
  expect(formatWebPreviewUrl(root, true)).toBe("http://localhost:5173/")
  expect(formatWebPreviewUrl(parseWebPreviewInput("[::1]:8080")!)).toBe("http://[::1]:8080")
  expect(normalizeWebPreviewUrl("http://localhost:5173/")).toBe("http://localhost:5173")
  expect(normalizeWebPreviewUrl("https://localhost:5173")).toBeNull()

  expect(formatWebPreviewTabTitle(target)).toBe("localhost:5173")
  expect(formatWebPreviewTabTitle("http://[::1]:8080/app")).toBe("[::1]:8080")
  expect(formatWebPreviewTabTitle(null, "Web Preview")).toBe("Web Preview")

  expect(isWebPreviewSupported({ platform: "darwin" })).toBe(true)
  expect(isWebPreviewSupported({ platform: "web" })).toBe(false)
})
