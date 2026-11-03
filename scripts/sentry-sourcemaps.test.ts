import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { uploadSourceMaps } from "./sentry-sourcemaps.ts"

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "deskfleet-sourcemaps-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = ["apps/web/dist/assets/web.js", "apps/desktop/out/main/client.js", "apps/desktop/out/renderer/assets/ui.js"]
  for (const file of files) {
    mkdirSync(join(root, file, ".."), { recursive: true })
    writeFileSync(join(root, file), "throw new Error('fixture')")
    writeFileSync(join(root, `${file}.map`), "{}")
  }
  const env = { VITE_SENTRY_DSN: "https://public@sentry.example/42", VITE_SENTRY_RELEASE: "deskfleet@v0.7.3", SENTRY_AUTH_TOKEN: "private-token", SENTRY_ORG: "org", SENTRY_PROJECT: "deskfleet" }
  return { root, files, env }
}

test("release upload uses exact URL prefixes and distributions, then removes only source maps", t => {
  const f = fixture(t)
  const calls: string[][] = []
  uploadSourceMaps(f.root, "macos-arm64", f.env, (args, env) => {
    calls.push(args)
    assert.equal(env.SENTRY_AUTH_TOKEN, "private-token")
    assert.ok(f.files.every(file => existsSync(join(f.root, `${file}.map`))), "all maps remain until upload completes")
  })
  assert.deepEqual(calls.map(args => [args[args.indexOf("--url-prefix") + 1], args[args.indexOf("--dist") + 1]]), [
    ["~/", "web"], ["app:///", "macos-arm64"], ["deskfleet-app://bundle/", "macos-arm64"],
  ])
  assert.ok(calls.every(args => args.includes("deskfleet@v0.7.3") && args.includes("--strict") && args.includes("--wait")))
  assert.ok(!JSON.stringify(calls).includes("private-token"))
  for (const file of f.files) {
    assert.equal(readFileSync(join(f.root, file), "utf8"), "throw new Error('fixture')")
    assert.ok(!existsSync(join(f.root, `${file}.map`)))
  }
})

test("an unconfigured project skips uploads and removes public maps", t => {
  const f = fixture(t)
  uploadSourceMaps(f.root, "windows-x64", {}, () => assert.fail("unexpected upload"))
  assert.ok(f.files.every(file => !existsSync(join(f.root, `${file}.map`))))
})

test("configured reporting requires upload credentials and fails on an upload error", t => {
  const f = fixture(t)
  assert.throws(() => uploadSourceMaps(f.root, "linux-x64", { ...f.env, SENTRY_AUTH_TOKEN: "" }), /requires SENTRY_AUTH_TOKEN/)
  const next = fixture(t)
  assert.throws(() => uploadSourceMaps(next.root, "linux-x64", next.env, () => { throw new Error("upload rejected") }), /upload rejected/)
  assert.ok(next.files.every(file => !existsSync(join(next.root, `${file}.map`))))
})

test("a missing bundle's maps fail the release instead of silently skipping it", t => {
  const f = fixture(t)
  rmSync(join(f.root, `${f.files[1]}.map`))
  assert.throws(() => uploadSourceMaps(f.root, "linux-arm64", f.env, () => {}), /No JavaScript source maps/)
})
