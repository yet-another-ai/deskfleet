import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { parse, stringify } from "yaml"
import { mergeMacUpdates } from "./merge-macos-updates.ts"

function fixture(t: TestContext, version: string) {
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-mac-updates-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const arm64Path = join(directory, "latest-mac.yml")
  const x64Path = join(directory, "latest-mac-x64.yml")
  const feed = (arch: string) => {
    const path = `deskfleet-${version}-mac-${arch}.zip`
    const sha512 = `${arch}-checksum`
    return { version, path, sha512, files: [{ url: path, sha512, size: 42 }] }
  }
  const arm64 = feed("arm64")
  const x64 = feed("x64")
  writeFileSync(arm64Path, stringify(arm64))
  writeFileSync(x64Path, stringify(x64))
  return { directory, arm64Path, x64Path, arm64, x64 }
}

test("the macOS update feed lists both architecture-specific ZIPs with their metadata", t => {
  const version = "0.21.0-rc.1"
  const { directory, arm64Path, x64Path, arm64, x64 } = fixture(t, version)
  mergeMacUpdates(directory, version)
  assert.deepEqual(parse(readFileSync(arm64Path, "utf8")), {
    ...arm64,
    files: [...arm64.files, ...x64.files],
  })
  assert.equal(existsSync(x64Path), false)
})

test("merging rejects the Intel feed for a different release before modifying either feed", t => {
  const version = "0.21.0"
  const { directory, arm64Path, x64Path, arm64, x64 } = fixture(t, version)
  const mismatched = { ...x64, version: "0.20.0" }
  writeFileSync(x64Path, stringify(mismatched))
  assert.throws(() => mergeMacUpdates(directory, version), /latest-mac-x64\.yml/)
  assert.deepEqual(parse(readFileSync(arm64Path, "utf8")), arm64)
  assert.deepEqual(parse(readFileSync(x64Path, "utf8")), mismatched)
})
