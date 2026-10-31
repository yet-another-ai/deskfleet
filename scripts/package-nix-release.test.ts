import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { gzipSync } from "node:zlib"
import { packageNixRelease } from "./package-nix-release.ts"

function fixture(context: TestContext, version = "1.2.3"): string {
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-package-nix-test-"))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, "nix"))
  mkdirSync(join(directory, "apps/desktop/build"), { recursive: true })
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version }))
  writeFileSync(join(directory, "nix/flake.nix"), '{ outputs = _: {}; }\n')
  writeFileSync(join(directory, "nix/flake.lock"), '{ "nodes": {}, "version": 7 }\n')
  writeFileSync(join(directory, "nix/desktop.nix"), '{}: null\n')
  writeFileSync(join(directory, "apps/desktop/build/icon.png"), Buffer.from([137, 80, 78, 71]))
  writeFileSync(join(directory, "unrelated.txt"), "This file must not ship in the release flake")
  return directory
}

function unpack(directory: string, archive: string): string {
  const extracted = join(directory, "extracted")
  mkdirSync(extracted)
  execFileSync("tar", ["-xzf", archive, "-C", extracted])
  assert.deepEqual(readdirSync(extracted), ["deskfleet-nix"])
  return join(extracted, "deskfleet-nix")
}

test("release flake pins both desktop archives and contains only the packaging inputs", async context => {
  const directory = fixture(context)
  const payloads = {
    "x86_64-linux": gzipSync("x64 Electron application and native addon"),
    "aarch64-linux": gzipSync("arm64 Electron application and native addon"),
  }
  const filenames = {
    "x86_64-linux": "deskfleet-1.2.3-linux-x64.tar.gz",
    "aarch64-linux": "deskfleet-1.2.3-linux-arm64.tar.gz",
  }
  for (const [system, filename] of Object.entries(filenames)) {
    writeFileSync(join(directory, filename), payloads[system as keyof typeof payloads])
  }
  const output = join(directory, "release/deskfleet-nix.tar.gz")
  await packageNixRelease(directory, output, Object.values(filenames))
  const extracted = unpack(directory, output)
  assert.deepEqual(readdirSync(extracted).sort(), ["desktop.nix", "flake.lock", "flake.nix", "icon.png", "release.json"])
  for (const filename of ["flake.nix", "flake.lock", "desktop.nix"]) {
    assert.deepEqual(readFileSync(join(extracted, filename)), readFileSync(join(directory, "nix", filename)))
  }
  assert.deepEqual(readFileSync(join(extracted, "icon.png")), readFileSync(join(directory, "apps/desktop/build/icon.png")))
  const release = JSON.parse(readFileSync(join(extracted, "release.json"), "utf8"))
  assert.equal(release.version, "1.2.3")
  assert.deepEqual(Object.keys(release.sources).sort(), Object.keys(filenames).sort())
  for (const [system, filename] of Object.entries(filenames)) {
    assert.equal(release.sources[system].url, `https://github.com/yet-another-ai/deskfleet/releases/download/v1.2.3/${filename}`)
    const expectedHash = createHash("sha256").update(readFileSync(join(directory, filename))).digest("base64")
    assert.equal(release.sources[system].hash, `sha256-${expectedHash}`)
  }
})

test("CLI packages a single architecture and preserves prerelease versions", context => {
  const directory = fixture(context, "1.2.3-rc.1")
  const filename = "deskfleet-1.2.3-rc.1-linux-arm64.tar.gz"
  writeFileSync(join(directory, filename), gzipSync("arm64 prerelease"))
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "package-nix-release.ts"), "deskfleet-nix.tar.gz", filename], {
    cwd: directory, encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  const extracted = unpack(directory, join(directory, "deskfleet-nix.tar.gz"))
  const release = JSON.parse(readFileSync(join(extracted, "release.json"), "utf8"))
  assert.equal(release.version, "1.2.3-rc.1")
  assert.deepEqual(Object.keys(release.sources), ["aarch64-linux"])
  assert.equal(release.sources["aarch64-linux"].url,
    `https://github.com/yet-another-ai/deskfleet/releases/download/v1.2.3-rc.1/${filename}`)
})

test("rejects mismatched releases, unsupported targets and duplicate architectures before writing output", async context => {
  const directory = fixture(context)
  const output = join(directory, "deskfleet-nix.tar.gz")
  const valid = "deskfleet-1.2.3-linux-x64.tar.gz"
  writeFileSync(join(directory, valid), gzipSync("desktop"))
  await assert.rejects(packageNixRelease(directory, output, []), /at least one/)
  for (const filename of ["deskfleet-2.0.0-linux-x64.tar.gz", "deskfleet-1.2.3-linux-ia32.tar.gz", "deskfleet-linux-x64.tar.gz"]) {
    await assert.rejects(packageNixRelease(directory, output, [filename]), /Expected a deskfleet-1.2.3-linux/)
  }
  await assert.rejects(packageNixRelease(directory, output, [valid, valid]), /Duplicate desktop archive for x86_64-linux/)
  assert.equal(existsSync(output), false)
})
