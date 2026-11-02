import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test, { type TestContext } from "node:test"
import { packageAurRelease } from "./package-aur-release.ts"

const repository = join(import.meta.dirname, "..")
const packageFiles = ["PKGBUILD", "deskfleet", "io.github.yet_another_ai.deskfleet.desktop", "icon.png", "LICENSE", "LICENSE.packaging"]

function fixture(context: TestContext, version = "1.2.3"): string {
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-package-aur-test-"))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, "packaging/aur"), { recursive: true })
  mkdirSync(join(directory, "docs/content/public"), { recursive: true })
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version }))
  writeFileSync(join(directory, "LICENSE"), "Product license\n")
  copyFileSync(join(repository, "docs/content/public/logo.png"), join(directory, "docs/content/public/logo.png"))
  for (const filename of ["PKGBUILD.in", "deskfleet", "io.github.yet_another_ai.deskfleet.desktop", "LICENSE.packaging"]) {
    copyFileSync(join(repository, "packaging/aur", filename), join(directory, "packaging/aur", filename))
  }
  return directory
}

function archive(directory: string, arch = "x64", version = "1.2.3", omit = ""): string {
  const prefix = `deskfleet-${version}-linux-${arch}`
  const bundle = join(directory, prefix)
  for (const filename of ["deskfleet", "chrome-sandbox", "resources/app.asar", "resources/app.asar.unpacked/out/main/deskfleet.node", "LICENSE.electron.txt", "LICENSES.chromium.html"]) {
    if (filename === omit) continue
    const target = join(bundle, filename)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `${arch}: ${filename}\n`, { mode: filename === "deskfleet" || filename === "chrome-sandbox" ? 0o755 : 0o644 })
  }
  const filename = `${prefix}.tar.gz`
  execFileSync("tar", ["-czf", join(directory, filename), "-C", directory, prefix])
  return filename
}

function digest(filename: string): string {
  return createHash("sha256").update(readFileSync(filename)).digest("hex")
}

test("AUR recipe pins both architectures and all local sources, with archives cached separately", async context => {
  const directory = fixture(context)
  const archives = [archive(directory, "arm64"), archive(directory)]
  const output = join(directory, "release/aur")
  await packageAurRelease(directory, output, archives)
  assert.deepEqual(readdirSync(output).sort(), [...packageFiles, ...archives].sort())
  const pkgbuild = readFileSync(join(output, "PKGBUILD"), "utf8")
  assert.match(pkgbuild, /^arch=\('x86_64' 'aarch64'\)$/m)
  assert.match(pkgbuild, /^pkgver=1\.2\.3$/m)
  assert.match(pkgbuild, /^provides=\("deskfleet=\$pkgver"\)$/m)
  assert.match(pkgbuild, /^conflicts=\('deskfleet'\)$/m)
  assert.doesNotMatch(pkgbuild, /@[A-Z_]+@|SKIP/)
  assert.equal(existsSync(join(output, ".SRCINFO")), false, "makepkg owns SRCINFO generation")
  for (const filename of archives) {
    assert.ok(pkgbuild.includes(`https://github.com/yet-another-ai/deskfleet/releases/download/v1.2.3/${filename}`))
    assert.ok(pkgbuild.includes(digest(join(directory, filename))))
    assert.deepEqual(readFileSync(join(output, filename)), readFileSync(join(directory, filename)))
  }
  for (const filename of packageFiles.filter(filename => filename !== "PKGBUILD")) {
    assert.ok(pkgbuild.includes(digest(join(output, filename))), `Missing checksum for ${filename}`)
  }
  assert.equal(readFileSync(join(output, "LICENSE"), "utf8"), "Product license\n")
})

test("CLI can override the checkout version and retains prerelease release URLs", context => {
  const directory = fixture(context, "9.0.0")
  const filename = archive(directory, "arm64", "1.2.3-rc.1")
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "package-aur-release.ts"), "aur", filename, "--version", "1.2.3-rc.1"], {
    cwd: directory, encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  const pkgbuild = readFileSync(join(directory, "aur/PKGBUILD"), "utf8")
  assert.match(pkgbuild, /^pkgver=1\.2\.3_rc\.1$/m)
  assert.match(pkgbuild, /^_upstreamVersion=1\.2\.3-rc\.1$/m)
  assert.match(pkgbuild, /^arch=\('aarch64'\)$/m)
  assert.ok(pkgbuild.includes(`/v1.2.3-rc.1/${filename}`))
  assert.doesNotMatch(pkgbuild, /^source_x86_64=/m)
})

test("package() installs the full Electron tree, desktop integration and licenses", { skip: process.platform !== "linux" }, async context => {
  const directory = fixture(context)
  const filename = archive(directory)
  const output = join(directory, "aur")
  await packageAurRelease(directory, output, [filename])
  const source = join(directory, "src")
  const destination = join(directory, "pkg")
  mkdirSync(source)
  execFileSync("tar", ["-xzf", join(directory, filename), "-C", source])
  for (const helper of packageFiles.filter(filename => filename !== "PKGBUILD")) copyFileSync(join(output, helper), join(source, helper))
  execFileSync("bash", ["-euc", 'source ./PKGBUILD; package'], {
    cwd: output,
    env: { ...process.env, CARCH: "x86_64", srcdir: source, pkgdir: destination },
  })
  assert.equal(readFileSync(join(destination, "opt/deskfleet/resources/app.asar.unpacked/out/main/deskfleet.node"), "utf8"), "x64: resources/app.asar.unpacked/out/main/deskfleet.node\n")
  assert.equal(readFileSync(join(destination, "usr/bin/deskfleet"), "utf8"), readFileSync(join(output, "deskfleet"), "utf8"))
  assert.equal(statSync(join(destination, "usr/bin/deskfleet")).mode & 0o7777, 0o755)
  assert.equal(statSync(join(destination, "opt/deskfleet/chrome-sandbox")).mode & 0o7777, 0o4755)
  assert.ok(existsSync(join(destination, "usr/share/applications/io.github.yet_another_ai.deskfleet.desktop")))
  assert.ok(existsSync(join(destination, "usr/share/icons/hicolor/256x256/apps/io.github.yet_another_ai.deskfleet.png")))
  assert.equal(readFileSync(join(destination, "usr/share/licenses/deskfleet-bin/LICENSE"), "utf8"), "Product license\n")
  assert.equal(readlinkSync(join(destination, "usr/share/licenses/deskfleet-bin/LICENSE.electron.txt")), "/opt/deskfleet/LICENSE.electron.txt")
  assert.equal(readlinkSync(join(destination, "usr/share/licenses/deskfleet-bin/LICENSES.chromium.html")), "/opt/deskfleet/LICENSES.chromium.html")
})

test("rejects mismatched, duplicate and incomplete desktop archives before producing a recipe", async context => {
  const directory = fixture(context)
  const output = join(directory, "aur")
  const valid = archive(directory)
  await assert.rejects(packageAurRelease(directory, output, []), /at least one/)
  for (const filename of ["deskfleet-2.0.0-linux-x64.tar.gz", "deskfleet-1.2.3-linux-ia32.tar.gz", "deskfleet-linux-x64.tar.gz"]) {
    await assert.rejects(packageAurRelease(directory, output, [filename]), /Expected a deskfleet-1.2.3-linux/)
  }
  await assert.rejects(packageAurRelease(directory, output, [valid, valid]), /Duplicate desktop archive for x86_64/)
  const incomplete = archive(directory, "arm64", "1.2.3", "resources/app.asar.unpacked/out/main/deskfleet.node")
  await assert.rejects(packageAurRelease(directory, output, [incomplete]), /missing .*deskfleet\.node/)
  await assert.rejects(packageAurRelease(directory, output, [valid], "1.2.3'; touch unsafe"), /Release tag must be/)
  assert.equal(existsSync(output), false)
})
