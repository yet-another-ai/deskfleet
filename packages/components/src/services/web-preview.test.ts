import { expect, test } from "vitest"
import {
  buildActualPreviewOrigin,
  buildActualPreviewUrl,
  extractLogicalPath,
  formatLogicalPreviewUrl,
  formatWebPreviewTabTitle,
  isWebPreviewSupported,
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

test("formats logical URLs, actual tunnel origins, path extraction, tab titles, and platform gating", () => {
  const target = parseWebPreviewInput("localhost:5173/dashboard?a=1")!
  expect(formatLogicalPreviewUrl(target)).toBe("http://localhost:5173/dashboard?a=1")
  expect(formatLogicalPreviewUrl(parseWebPreviewInput("5173")!)).toBe("http://localhost:5173")
  expect(formatLogicalPreviewUrl(parseWebPreviewInput("[::1]:8080")!)).toBe("http://[::1]:8080")

  const origin = buildActualPreviewOrigin("127.0.0.1", 49152)
  expect(origin).toBe("http://127.0.0.1:49152")
  expect(buildActualPreviewOrigin("localhost", 80)).toBe("http://localhost")
  expect(buildActualPreviewUrl(origin, target.path)).toBe("http://127.0.0.1:49152/dashboard?a=1")

  expect(extractLogicalPath("http://127.0.0.1:49152/settings?x=2#hash", origin)).toBe("/settings?x=2#hash")
  expect(extractLogicalPath("http://127.0.0.1:9999/other", origin)).toBeNull()

  expect(formatWebPreviewTabTitle(target, "Vite App")).toBe("Vite App")
  expect(formatWebPreviewTabTitle(target, "127.0.0.1:49152/dashboard")).toBe("localhost:5173")
  expect(formatWebPreviewTabTitle(null, "", "Web Preview")).toBe("Web Preview")

  expect(isWebPreviewSupported({ platform: "darwin" })).toBe(true)
  expect(isWebPreviewSupported({ platform: "web" })).toBe(false)
})
