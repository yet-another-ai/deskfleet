import { execFileSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { readReleaseVersions, validateReleaseTag } from "./release-version.ts"

const sourceArchitectures = {
  x64: { deb: "amd64", rpm: "x86_64" },
  arm64: { deb: "arm64", rpm: "aarch64" },
} as const

export type LinuxSourceArchitecture = keyof typeof sourceArchitectures
export type LinuxPackageFormat = keyof (typeof sourceArchitectures)["x64"]

export interface LinuxPackageOptions {
  formats?: readonly LinuxPackageFormat[]
  version?: string
}

export interface LinuxPackageResult {
  file: string
  format: LinuxPackageFormat
  architecture: LinuxSourceArchitecture
}

const formats: readonly LinuxPackageFormat[] = ["deb", "rpm"]
const bundleMembers = [
  "deskfleet",
  "chrome-sandbox",
  "resources/app.asar",
  "resources/app.asar.unpacked/out/main/deskfleet.node",
  "LICENSE.electron.txt",
  "LICENSES.chromium.html",
] as const
const debDepends = [
  "libasound2t64 | libasound2",
  "libatspi2.0-0t64 | libatspi2.0-0",
  "libcairo2",
  "libcups2t64 | libcups2",
  "libdbus-1-3",
  "libdrm2",
  "libexpat1",
  "libgbm1",
  "libgcc-s1",
  "libgl1",
  "libglib2.0-0t64 | libglib2.0-0",
  "libgtk-3-0t64 | libgtk-3-0",
  "libnspr4",
  "libnss3",
  "libpango-1.0-0",
  "libsystemd0",
  "libx11-6",
  "libx11-xcb1",
  "libxcb1",
  "libxcomposite1",
  "libxdamage1",
  "libxext6",
  "libxfixes3",
  "libxkbcommon0",
  "libxkbfile1",
  "libxrandr2",
  "libxshmfence1",
  "libxss1",
  "libxtst6",
  "libuuid1",
  "hicolor-icon-theme",
  "git",
]
const debRecommends = [
  "gstreamer1.0-plugins-base",
  "gstreamer1.0-plugins-bad",
  "gstreamer1.0-pipewire",
  "libnotify4",
  "libsecret-1-0",
  "xdg-desktop-portal",
]
const rpmRequires = [
  "alsa-lib",
  "at-spi2-core",
  "cairo",
  "cups-libs",
  "dbus-libs",
  "expat",
  "git",
  "glib2",
  "gtk3",
  "hicolor-icon-theme",
  "libdrm",
  "libgcc",
  "libstdc++",
  "libX11",
  "libX11-xcb",
  "libXcomposite",
  "libXdamage",
  "libXext",
  "libXfixes",
  "libXrandr",
  "libXScrnSaver",
  "libXtst",
  "libuuid",
  "libxcb",
  "libxkbcommon",
  "libxkbfile",
  "libxshmfence",
  "mesa-libGL",
  "mesa-libgbm",
  "nspr",
  "nss",
  "pango",
  "systemd-libs",
  "xdg-utils",
]
const rpmRecommends = [
  "gstreamer1-plugins-base",
  "gstreamer1-plugins-bad-free",
  "libnotify",
  "libsecret",
  "pipewire-gstreamer",
  "xdg-desktop-portal",
]

/** Translate a SemVer prerelease into the RPM and Debian version ordering syntax. */
export function linuxPackageVersion(version: string): string {
  return version.replaceAll("-", "~")
}

export function linuxPackageFilename(
  version: string,
  format: LinuxPackageFormat,
  architecture: LinuxSourceArchitecture,
): string {
  return `deskfleet-${version}-linux-${sourceArchitectures[architecture][format]}.${format}`
}

export function renderDebControl(
  version: string,
  architecture: LinuxSourceArchitecture,
  installedSize: number,
  template = readFileSync(new URL("../packaging/linux/deb-control.in", import.meta.url), "utf8"),
): string {
  return template
    .replaceAll("@VERSION@", linuxPackageVersion(version))
    .replaceAll("@ARCH@", sourceArchitectures[architecture].deb)
    .replaceAll("@INSTALLED_SIZE@", String(installedSize))
    .replaceAll("@DEPENDS@", debDepends.join(", "))
    .replaceAll("@RECOMMENDS@", debRecommends.join(", "))
}

export function renderRpmSpec(
  version: string,
  architecture: LinuxSourceArchitecture,
  template = readFileSync(new URL("../packaging/linux/deskfleet.spec.in", import.meta.url), "utf8"),
): string {
  return template
    .replaceAll("@VERSION@", linuxPackageVersion(version))
    .replaceAll("@ARCH@", sourceArchitectures[architecture].rpm)
    .replaceAll("@REQUIRES@", rpmRequires.map(name => `Requires:       ${name}`).join("\n"))
    .replaceAll("@RECOMMENDS@", rpmRecommends.map(name => `Recommends:     ${name}`).join("\n"))
}

function install(source: string, target: string, mode: number): void {
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  chmodSync(target, mode)
}

function writeDebianIcon(root: string, payload: string): void {
  install(join(payload, "icon.png"), join(root, "usr/share/icons/hicolor/256x256/apps/io.github.yet_another_ai.deskfleet.png"), 0o644)
}

function writeLicenses(root: string, payload: string, directory: string): void {
  const docs = join(root, directory, "deskfleet")
  mkdirSync(docs, { recursive: true })
  install(join(payload, "LICENSE"), join(docs, "LICENSE"), 0o644)
  install(join(payload, "LICENSE.packaging"), join(docs, "LICENSE.packaging"), 0o644)
  symlinkSync("/usr/lib/deskfleet/LICENSE.electron.txt", join(docs, "LICENSE.electron.txt"))
  symlinkSync("/usr/lib/deskfleet/LICENSES.chromium.html", join(docs, "LICENSES.chromium.html"))
}

function buildDeb(temporary: string, payload: string, output: string, version: string, architecture: LinuxSourceArchitecture): void {
  const root = join(temporary, `deb-${architecture}`)
  mkdirSync(join(root, "DEBIAN"), { recursive: true })
  mkdirSync(join(root, "usr/lib"), { recursive: true })
  execFileSync("cp", ["-a", join(payload, "app"), join(root, "usr/lib/deskfleet")], { stdio: "inherit" })
  install(join(payload, "deskfleet"), join(root, "usr/bin/deskfleet"), 0o755)
  install(
    join(payload, "io.github.yet_another_ai.deskfleet.desktop"),
    join(root, "usr/share/applications/io.github.yet_another_ai.deskfleet.desktop"),
    0o644,
  )
  writeDebianIcon(root, payload)
  writeLicenses(root, payload, "usr/share/doc")
  copyFileSync(join(payload, "LICENSE"), join(root, "usr/share/doc/deskfleet/copyright"))
  const installedSize = Number(execFileSync("du", ["-sk", root], { encoding: "utf8" }).trim().split(/\s+/u)[0])
  writeFileSync(join(root, "DEBIAN/control"), renderDebControl(
    version,
    architecture,
    installedSize,
    readFileSync(join(payload, "deb-control.in"), "utf8"),
  ))
  execFileSync("dpkg-deb", ["--root-owner-group", "--build", root, output], { stdio: "inherit" })
}

function buildRpm(temporary: string, payload: string, output: string, version: string, architecture: LinuxSourceArchitecture): void {
  const rpmArchitecture = sourceArchitectures[architecture].rpm
  const topdir = join(temporary, `rpmbuild-${architecture}`)
  for (const directory of ["BUILD", "BUILDROOT", "RPMS", "SOURCES", "SPECS", "SRPMS"]) {
    mkdirSync(join(topdir, directory), { recursive: true })
  }
  const spec = join(topdir, "SPECS/deskfleet.spec")
  writeFileSync(spec, renderRpmSpec(version, architecture, readFileSync(join(payload, "deskfleet.spec.in"), "utf8")))
  execFileSync("rpmbuild", [
    "-bb",
    "--target", rpmArchitecture,
    "--define", `_topdir ${topdir}`,
    "--define", `_sourcedir ${payload}`,
    spec,
  ], { stdio: "inherit" })
  const builtDirectory = join(topdir, "RPMS", rpmArchitecture)
  const built = readdirSync(builtDirectory).filter(name => name.endsWith(".rpm"))
  if (built.length !== 1) throw new Error(`rpmbuild produced ${built.length} packages for ${rpmArchitecture}`)
  copyFileSync(join(builtDirectory, built[0]!), output)
}

function stagePayload(
  directory: string,
  temporary: string,
  archive: string,
  version: string,
  architecture: LinuxSourceArchitecture,
): string {
  const filename = basename(archive)
  const extracted = join(temporary, `source-${architecture}`)
  mkdirSync(extracted)
  execFileSync("tar", ["-xzf", resolve(directory, archive), "-C", extracted], { stdio: "inherit" })
  const bundle = join(extracted, filename.slice(0, -".tar.gz".length))
  for (const member of bundleMembers) {
    try {
      statSync(join(bundle, member))
    } catch {
      throw new Error(`Desktop archive ${filename} is missing ${member}`)
    }
  }

  const payload = join(temporary, `payload-${architecture}`)
  mkdirSync(join(payload, "app"), { recursive: true })
  execFileSync("cp", ["-a", `${bundle}/.`, join(payload, "app")], { stdio: "inherit" })
  const template = join(directory, "packaging/linux")
  for (const [source, target, mode] of [
    [join(template, "deb-control.in"), join(payload, "deb-control.in"), 0o644],
    [join(template, "deskfleet"), join(payload, "deskfleet"), 0o755],
    [join(template, "deskfleet.spec.in"), join(payload, "deskfleet.spec.in"), 0o644],
    [join(template, "io.github.yet_another_ai.deskfleet.desktop"), join(payload, "io.github.yet_another_ai.deskfleet.desktop"), 0o644],
    [join(template, "LICENSE.packaging"), join(payload, "LICENSE.packaging"), 0o644],
    [join(directory, "LICENSE"), join(payload, "LICENSE"), 0o644],
    [join(directory, "docs/content/public/logo.png"), join(payload, "icon.png"), 0o644],
  ] as const) {
    install(source, target, mode)
  }
  // Chromium's sandbox helper must stay setuid root inside both package formats.
  chmodSync(join(payload, "app/chrome-sandbox"), 0o4755)
  return payload
}

function archiveArchitecture(filename: string, version: string): LinuxSourceArchitecture {
  const match = /^deskfleet-(.+)-linux-(x64|arm64)\.tar\.gz$/u.exec(filename)
  if (!match || match[1] !== version) {
    throw new Error(`Expected a deskfleet-${version}-linux-{x64,arm64}.tar.gz desktop archive; received ${filename}`)
  }
  return match[2] as LinuxSourceArchitecture
}

export async function packageLinuxRelease(
  directory: string,
  destination: string,
  archives: readonly string[],
  options: LinuxPackageOptions = {},
): Promise<LinuxPackageResult[]> {
  if (archives.length === 0) throw new Error("Provide at least one Linux desktop archive")
  const version = options.version ?? (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { version: string }).version
  validateReleaseTag(`v${version}`, readReleaseVersions(directory))
  const requested = options.formats ?? formats
  if (requested.length === 0 || requested.some(format => !formats.includes(format))) {
    throw new Error(`Linux package formats must be ${formats.join(" and ")}`)
  }

  const sources = new Map<LinuxSourceArchitecture, string>()
  for (const archive of archives) {
    const filename = basename(archive)
    const architecture = archiveArchitecture(filename, version)
    if (sources.has(architecture)) throw new Error(`Duplicate desktop archive for ${architecture}`)
    statSync(resolve(directory, archive))
    sources.set(architecture, archive)
  }

  const temporary = mkdtempSync(join(tmpdir(), "deskfleet-linux-packages-"))
  try {
    const results: LinuxPackageResult[] = []
    const built: { result: LinuxPackageResult; path: string }[] = []
    for (const architecture of Object.keys(sourceArchitectures) as LinuxSourceArchitecture[]) {
      const archive = sources.get(architecture)
      if (!archive) continue
      const payload = stagePayload(directory, temporary, archive, version, architecture)
      for (const format of formats.filter(value => requested.includes(value))) {
        const result: LinuxPackageResult = {
          file: linuxPackageFilename(version, format, architecture),
          format,
          architecture,
        }
        const path = join(temporary, result.file)
        if (format === "deb") buildDeb(temporary, payload, path, version, architecture)
        else buildRpm(temporary, payload, path, version, architecture)
        built.push({ result, path })
      }
    }
    const output = resolve(directory, destination)
    mkdirSync(output, { recursive: true })
    for (const { result, path } of built) {
      copyFileSync(path, join(output, result.file))
      results.push(result)
    }
    return results
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    options: { format: { type: "string" }, version: { type: "string" } },
    allowPositionals: true,
  })
  const [destination, ...archives] = positionals
  if (!destination || archives.length === 0) {
    throw new Error("Usage: node scripts/package-linux-release.ts [--format deb,rpm] [--version <version>] <output-dir> <desktop.tar.gz> [desktop.tar.gz ...]")
  }
  const requested = values.format === undefined
    ? formats
    : values.format.split(",").map(value => value.trim()).filter(value => value.length > 0)
  const results = await packageLinuxRelease(process.cwd(), destination, archives, {
    formats: requested as LinuxPackageFormat[],
    version: values.version,
  })
  console.log(`Packaged Linux distribution release: ${results.map(result => result.file).join(", ")}`)
}
