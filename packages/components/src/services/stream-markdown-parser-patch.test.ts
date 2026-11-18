import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { registerCacheStableLinkValidator } from "markstream-vue"

/**
 * markstream-vue re-exports stream-markdown-parser. The carry-across
 * `stream-markdown-parser@*` patch must keep exporting
 * `registerCacheStableLinkValidator` after Renovate bumps (see #591).
 */
describe("stream-markdown-parser patch", () => {
  it("exports registerCacheStableLinkValidator through markstream-vue", () => {
    expect(typeof registerCacheStableLinkValidator).toBe("function")
  })

  it("applies the CJS and ESM export lines on the locked package", () => {
    const markstreamEntry = fileURLToPath(import.meta.resolve("markstream-vue"))
    // pnpm layout: .../node_modules/markstream-vue/dist/index.js
    // sibling:     .../node_modules/stream-markdown-parser
    const streamRoot = join(dirname(dirname(dirname(markstreamEntry))), "stream-markdown-parser")
    expect(existsSync(streamRoot), `expected pnpm sibling stream-markdown-parser at ${streamRoot}`).toBe(true)
    const cjs = readFileSync(join(streamRoot, "dist/index.cjs"), "utf8")
    const esm = readFileSync(join(streamRoot, "dist/index.js"), "utf8")
    expect(cjs).toContain("exports.registerCacheStableLinkValidator = registerCacheStableLinkValidator")
    expect(esm).toContain("export { registerCacheStableLinkValidator }")
  })
})
