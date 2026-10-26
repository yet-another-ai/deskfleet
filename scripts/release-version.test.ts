import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { readReleaseVersions, validateReleaseTag } from "./release-version.ts"

const versions = (version: string) => ({ root: version, desktop: version, cargo: version })

test("stable and prerelease tags must match every shipped version", () => {
  for (const version of ["0.1.0", "1.2.3", "10.20.30-rc.1", "0.1.0-beta.0", "1.0.0-1a.2-3"]) {
    assert.deepEqual(validateReleaseTag(`v${version}`, versions(version)), {
      tag: `v${version}`, version, prerelease: version.includes("-"),
    })
  }
  for (const manifest of ["root", "desktop", "cargo"]) {
    assert.throws(() => validateReleaseTag("v0.1.0", { ...versions("0.1.0"), [manifest]: "0.2.0" }), /does not match/)
  }
})

test("rejects malformed tags and versions that cannot become OCI tags", () => {
  for (const tag of ["", "0.1.0", "v1", "v1.0", "v01.0.0", "v1.02.0", "v1.0.03", "v1.0.0-01", "v1.0.0-rc.01", "v1.0.0-", "v1.0.0-rc..1", "v1.0.0+build.1", "v1.0.0\n", "v1.0.0/rc"]) {
    assert.throws(() => validateReleaseTag(tag, versions(tag.slice(1))), /Release tag must/, tag)
  }
})

test("CLI reads workspace and Electron versions, writes outputs only after validation", context => {
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-release-version-"))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, "apps/desktop"), { recursive: true })
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "1.2.3-rc.1" }))
  writeFileSync(join(directory, "apps/desktop/package.json"), JSON.stringify({ version: "1.2.3-rc.1" }))
  writeFileSync(join(directory, "Cargo.toml"), '[workspace]\nresolver = "3"\n\n[workspace.package]\nversion = "1.2.3-rc.1"\nedition = "2024"\n\n[workspace.dependencies]\nother = { version = "9" }\n')
  assert.deepEqual(readReleaseVersions(directory), versions("1.2.3-rc.1"))
  const output = join(directory, "output")
  const run = (tag: string) => spawnSync(process.execPath, [join(import.meta.dirname, "release-version.ts"), tag], {
    cwd: directory, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output },
  })
  assert.equal(run("v1.2.3-rc.1").status, 0)
  assert.equal(readFileSync(output, "utf8"), "tag=v1.2.3-rc.1\nversion=1.2.3-rc.1\nprerelease=true\n")
  writeFileSync(output, "")
  assert.notEqual(run("v1.2.3").status, 0)
  assert.equal(readFileSync(output, "utf8"), "")
  writeFileSync(join(directory, "Cargo.toml"), '[package]\nversion = "1.2.3-rc.1"\n')
  assert.throws(() => readReleaseVersions(directory), /workspace.package.version/)
})
