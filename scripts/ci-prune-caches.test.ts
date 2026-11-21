import assert from "node:assert/strict"
import test from "node:test"
import { type Cache, cacheFamily, staleCaches } from "./ci-prune-caches.ts"

const hash = (seed: string) => seed.repeat(64).slice(0, 64)

test("Cargo cache families group changing inputs by role and platform", () => {
  assert.equal(cacheFamily("v0-rust-test-Linux-x64-b020bd42-86efabf1"), "v0-rust-test-Linux-x64")
  assert.equal(cacheFamily("v0-rust-test-Windows_NT-x64-e52fca1b-39defabf"), "v0-rust-test-Windows_NT-x64")
  assert.equal(cacheFamily("v0-rust-static-Linux-x64-b020bd42-86efabf1"), "v0-rust-static-Linux-x64")
  assert.equal(cacheFamily("v0-rust-test-Linux-arm64-b020bd42-86efabf1"), "v0-rust-test-Linux-arm64")
})

test("stale caches include retired downloads, off-main entries, and older entries per active family", () => {
  let id = 0
  const cache = (key: string, created: string, ref = "refs/heads/main"): Cache =>
    ({ id: ++id, key, ref, created_at: `2026-11-0${created}T00:00:00Z`, size_in_bytes: 1 })
  const cargoDownloads = cache(`cargo-downloads-Windows-X64-${hash("a")}`, "1")
  const pnpmStore = cache(`pnpm-store-Linux-X64-${hash("b")}`, "3")
  const electron = cache("electron-Linux-X64-45.2.2", "1")
  const mise = cache(`mise-v1-linux-x64-ubuntu26-2026.11.9-ci-p692-${hash("c")}`, "1")
  const oldRust = cache("v0-rust-test-Linux-x64-00000000-11111111", "1")
  const newRust = cache("v0-rust-test-Linux-x64-22222222-33333333", "3")
  const middleRust = cache("v0-rust-test-Linux-x64-44444444-55555555", "2")
  const release = cache("v0-rust-release-Linux-x64-11111111-22222222", "1")
  const pullRequest = cache(newRust.key, "4", "refs/pull/415/merge")
  const tag = cache(newRust.key, "4", "refs/tags/v0.2.1")

  const stale = staleCaches([cargoDownloads, pnpmStore, electron, mise, oldRust, newRust, middleRust, release, pullRequest, tag])
  assert.deepEqual(new Set(stale), new Set([cargoDownloads, pnpmStore, electron, mise, oldRust, middleRust, pullRequest, tag]))
  assert.deepEqual(staleCaches([newRust, release]), [])
})
