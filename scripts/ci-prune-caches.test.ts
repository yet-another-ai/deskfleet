import assert from "node:assert/strict"
import test from "node:test"
import { type Cache, cacheFamily, staleCaches } from "./ci-prune-caches.ts"

const hash = (seed: string) => seed.repeat(64).slice(0, 64)

test("cache families drop only the segments that change with inputs", () => {
  const families: Array<[string, string]> = [
    [`pnpm-store-Linux-X64-${hash("a")}`, "pnpm-store-Linux-X64"],
    [`cargo-downloads-Windows-X64-${hash("b")}`, "cargo-downloads-Windows-X64"],
    ["electron-macOS-ARM64-45.2.2", "electron-macOS-ARM64"],
    ["v0-rust-test-Linux-x64-b020bd42-86efabf1", "v0-rust-test-Linux-x64"],
    [`mise-v1-linux-x64-ubuntu26-2026.11.3-ci-p692-${hash("c")}`, "mise-v1-linux-x64-ubuntu26-2026.11.3-ci"],
  ]
  for (const [key, family] of families) assert.equal(cacheFamily(key), family, key)
  // A Node-only toolchain is a different entry from the full toolchain.
  assert.notEqual(
    cacheFamily(`mise-v1-linux-x64-ubuntu26-2026.11.3-ci-${hash("d")}-p692-${hash("c")}`),
    cacheFamily(`mise-v1-linux-x64-ubuntu26-2026.11.3-ci-p692-${hash("c")}`),
  )
  // Roles and platforms stay separate.
  assert.notEqual(cacheFamily("v0-rust-test-Linux-x64-b020bd42-86efabf1"), cacheFamily("v0-rust-static-Linux-x64-b020bd42-86efabf1"))
  assert.notEqual(cacheFamily(`pnpm-store-Linux-X64-${hash("a")}`), cacheFamily(`pnpm-store-Linux-ARM64-${hash("a")}`))
})

test("stale caches are everything outside main and all but main's newest per family", () => {
  let id = 0
  const cache = (key: string, created: string, ref = "refs/heads/main"): Cache =>
    ({ id: ++id, key, ref, created_at: `2026-11-0${created}T00:00:00Z`, size_in_bytes: 1 })
  const oldStore = cache(`pnpm-store-Linux-X64-${hash("a")}`, "1")
  const newStore = cache(`pnpm-store-Linux-X64-${hash("b")}`, "3")
  const middleStore = cache(`pnpm-store-Linux-X64-${hash("c")}`, "2")
  const oldRust = cache("v0-rust-test-Linux-x64-00000000-11111111", "1")
  const newRust = cache("v0-rust-test-Linux-x64-22222222-33333333", "2")
  const onlyElectron = cache("electron-Linux-X64-45.2.2", "1")
  const pullRequest = cache(`pnpm-store-Linux-X64-${hash("d")}`, "4", "refs/pull/415/merge")
  const tag = cache("electron-Linux-X64-45.2.2", "4", "refs/tags/v0.2.1")

  const stale = staleCaches([oldStore, newStore, middleStore, oldRust, newRust, onlyElectron, pullRequest, tag])
  assert.deepEqual(new Set(stale.map(entry => entry.id)), new Set([oldStore, middleStore, oldRust, pullRequest, tag].map(entry => entry.id)))
  assert.deepEqual(staleCaches([newStore, onlyElectron]), [])
})
