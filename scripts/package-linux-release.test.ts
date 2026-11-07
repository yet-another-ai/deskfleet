import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test, { type TestContext } from "node:test"
import {
  linuxPackageFilename,
  linuxPackageVersion,
  packageLinuxRelease,
  renderDebControl,
  renderRpmSpec,
} from "./package-linux-release.ts"

const repository = join(import.meta.dirname, "..")

function temporary(context: TestContext, prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function fixture(context: TestContext, version = "1.2.3"): string {
  const directory = temporary(context, "deskfleet-package-linux-test-")
  mkdirSync(join(directory, "packaging/linux"), { recursive: true })
  mkdirSync(join(directory, "apps/desktop"), { recursive: true })
  mkdirSync(join(directory, "docs/content/public"), { recursive: true })
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version }))
  writeFileSync(join(directory, "apps/desktop/package.json"), JSON.stringify({ version }))
  writeFileSync(join(directory, "Cargo.toml"), `[workspace.package]\nversion = "${version}"\n`)
  writeFileSync(join(directory, "LICENSE"), "Product license\n")
  copyFileSync(join(repository, "docs/content/public/logo.png"), join(directory, "docs/content/public/logo.png"))
  for (const filename of ["deb-control.in", "deskfleet", "deskfleet.spec.in", "io.github.yet_another_ai.deskfleet.desktop", "LICENSE.packaging"]) {
    copyFileSync(join(repository, "packaging/linux", filename), join(directory, "packaging/linux", filename))
  }
  return directory
}

function archive(directory: string, arch = "x64", version = "1.2.3", omit = ""): string {
  const prefix = `deskfleet-${version}-linux-${arch}`
  const bundle = join(directory, prefix)
  for (const filename of [
    "deskfleet",
    "chrome-sandbox",
    "resources/app.asar",
    "resources/app.asar.unpacked/out/main/deskfleet.node",
    "LICENSE.electron.txt",
    "LICENSES.chromium.html",
  ]) {
    if (filename === omit) continue
    const target = join(bundle, filename)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `${arch}: ${filename}\n`, { mode: filename === "deskfleet" || filename === "chrome-sandbox" ? 0o755 : 0o644 })
  }
  const filename = `${prefix}.tar.gz`
  execFileSync("tar", ["-czf", join(directory, filename), "-C", directory, prefix])
  return filename
}

function available(command: string): boolean {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const buildable = process.platform === "linux" && available("dpkg-deb") && available("rpmbuild") && available("rpm")

test("package versions use native ordering and names use native architectures", () => {
  assert.equal(linuxPackageVersion("1.2.3"), "1.2.3")
  assert.equal(linuxPackageVersion("1.2.3-rc.1"), "1.2.3~rc.1")
  assert.equal(linuxPackageFilename("1.2.3", "deb", "x64"), "deskfleet-1.2.3-linux-amd64.deb")
  assert.equal(linuxPackageFilename("1.2.3", "deb", "arm64"), "deskfleet-1.2.3-linux-arm64.deb")
  assert.equal(linuxPackageFilename("1.2.3", "rpm", "x64"), "deskfleet-1.2.3-linux-x86_64.rpm")
  assert.equal(linuxPackageFilename("1.2.3", "rpm", "arm64"), "deskfleet-1.2.3-linux-aarch64.rpm")
})

test("package metadata renders complete control and spec files", () => {
  const control = renderDebControl("1.2.3-rc.1", "arm64", 1234)
  assert.match(control, /^Package: deskfleet$/m)
  assert.match(control, /^Version: 1\.2\.3~rc\.1$/m)
  assert.match(control, /^Architecture: arm64$/m)
  assert.match(control, /^Installed-Size: 1234$/m)
  assert.match(control, /^Depends: .*libgtk-3-0t64 \| libgtk-3-0.*$/m)
  assert.match(control, /^Recommends: .*xdg-desktop-portal$/m)
  assert.doesNotMatch(control, /@[A-Z_]+@/u)

  const spec = renderRpmSpec("1.2.3-rc.1", "arm64")
  assert.match(spec, /^Version:\s+1\.2\.3~rc\.1$/m)
  assert.match(spec, /^BuildArch:\s+aarch64$/m)
  assert.match(spec, /^Requires:\s+gtk3$/m)
  assert.match(spec, /^Recommends:\s+xdg-desktop-portal$/m)
  assert.doesNotMatch(spec, /@[A-Z_]+@/u)
})

test("release publication verifies every generated package asset", () => {
  const yaml = readFileSync(join(repository, ".github/workflows/publish.yml"), "utf8")
  for (const format of ["deb", "rpm"] as const) {
    for (const architecture of ["x64", "arm64"] as const) {
      assert.ok(yaml.includes(`"${linuxPackageFilename("$VERSION", format, architecture)}"`),
        `${format} ${architecture} must be a required release asset`)
    }
  }
})

test("builds installable deb and rpm packages from desktop archives", { skip: !buildable }, async context => {
  const architecture = process.arch === "arm64" ? "arm64" : "x64"
  const debArchitecture = architecture === "x64" ? "amd64" : "arm64"
  const rpmArchitecture = architecture === "x64" ? "x86_64" : "aarch64"
  const directory = fixture(context)
  const filename = archive(directory, architecture)
  const output = join(directory, "release")
  const results = await packageLinuxRelease(directory, output, [filename])
  assert.deepEqual(results.map(result => result.file), [
    linuxPackageFilename("1.2.3", "deb", architecture),
    linuxPackageFilename("1.2.3", "rpm", architecture),
  ])
  assert.deepEqual(readdirSync(output).sort(), results.map(result => result.file).sort())

  const deb = join(output, linuxPackageFilename("1.2.3", "deb", architecture))
  assert.equal(execFileSync("dpkg-deb", ["--field", deb, "Version"], { encoding: "utf8" }).trim(), "1.2.3")
  assert.equal(execFileSync("dpkg-deb", ["--field", deb, "Architecture"], { encoding: "utf8" }).trim(), debArchitecture)
  const contents = execFileSync("dpkg-deb", ["--contents", deb], { encoding: "utf8" })
  for (const member of [
    "./usr/bin/deskfleet",
    "./usr/lib/deskfleet/deskfleet",
    "./usr/lib/deskfleet/chrome-sandbox",
    "./usr/lib/deskfleet/resources/app.asar",
    "./usr/lib/deskfleet/resources/app.asar.unpacked/out/main/deskfleet.node",
    "./usr/share/applications/io.github.yet_another_ai.deskfleet.desktop",
    "./usr/share/icons/hicolor/256x256/apps/io.github.yet_another_ai.deskfleet.png",
    "./usr/share/doc/deskfleet/copyright",
    "./usr/share/doc/deskfleet/LICENSE.electron.txt",
  ]) assert.ok(contents.includes(member), member)
  assert.match(contents, /^-rwsr-xr-x .*\.\/usr\/lib\/deskfleet\/chrome-sandbox$/m)

  const rpm = join(output, linuxPackageFilename("1.2.3", "rpm", architecture))
  assert.equal(execFileSync("rpm", ["-qp", "--queryformat", "%{VERSION}|%{ARCH}", rpm], { encoding: "utf8" }), `1.2.3|${rpmArchitecture}`)
  const files = execFileSync("rpm", ["-qlp", rpm], { encoding: "utf8" })
  for (const member of [
    "/usr/bin/deskfleet",
    "/usr/lib/deskfleet/deskfleet",
    "/usr/lib/deskfleet/chrome-sandbox",
    "/usr/share/applications/io.github.yet_another_ai.deskfleet.desktop",
    "/usr/share/licenses/deskfleet/LICENSE",
  ]) assert.ok(files.includes(member), member)
})

test("builds a prerelease rpm with ordering-safe metadata", { skip: !buildable || !available("rpm") }, async context => {
  const architecture = process.arch === "arm64" ? "arm64" : "x64"
  const rpmArchitecture = architecture === "x64" ? "x86_64" : "aarch64"
  const directory = fixture(context, "1.2.3-rc.1")
  const filename = archive(directory, architecture, "1.2.3-rc.1")
  const output = join(directory, "release")
  await packageLinuxRelease(directory, output, [filename], { formats: ["rpm"] })
  const rpm = join(output, linuxPackageFilename("1.2.3-rc.1", "rpm", architecture))
  assert.equal(execFileSync("rpm", ["-qp", "--queryformat", "%{VERSION}|%{ARCH}", rpm], { encoding: "utf8" }),
    `1.2.3~rc.1|${rpmArchitecture}`)
  assert.ok(existsSync(rpm))
})

test("rejects mismatched, duplicate, incomplete and invalid desktop archives before producing packages", async context => {
  const directory = fixture(context)
  const output = join(directory, "release")
  const valid = archive(directory)
  await assert.rejects(packageLinuxRelease(directory, output, []), /at least one/)
  for (const filename of ["deskfleet-2.0.0-linux-x64.tar.gz", "deskfleet-1.2.3-linux-ia32.tar.gz", "deskfleet-linux-x64.tar.gz"]) {
    await assert.rejects(packageLinuxRelease(directory, output, [filename]), /Expected a deskfleet-1\.2\.3-linux/)
  }
  await assert.rejects(packageLinuxRelease(directory, output, [valid, valid]), /Duplicate desktop archive for x64/)
  await assert.rejects(packageLinuxRelease(directory, output, [valid], { formats: ["pacman" as never] }), /Linux package formats/)
  await assert.rejects(packageLinuxRelease(directory, output, [valid], { version: "1.2.3'; touch unsafe" }), /Release tag must be/)
  const incomplete = archive(directory, "arm64", "1.2.3", "resources/app.asar.unpacked/out/main/deskfleet.node")
  await assert.rejects(packageLinuxRelease(directory, output, [incomplete]), /missing .*deskfleet\.node/)
  assert.equal(existsSync(output), false)
})

test("package build output stays untouched on failure", async context => {
  const directory = fixture(context)
  const output = join(directory, "release")
  writeFileSync(join(directory, "deskfleet-1.2.3-linux-x64.tar.gz"), "not a tar archive")
  await assert.rejects(packageLinuxRelease(directory, output, ["deskfleet-1.2.3-linux-x64.tar.gz"]), /tar/u)
  assert.equal(existsSync(output), false)
  assert.deepEqual(readdirSync(directory).filter(name => name.startsWith("deskfleet-") && name.endsWith(".deb")), [])
})
