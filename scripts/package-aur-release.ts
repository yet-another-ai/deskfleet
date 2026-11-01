import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { validateReleaseTag } from "./release-version.ts"

const architectures = { x64: "x86_64", arm64: "aarch64" } as const
const helpers = ["deskfleet", "io.github.yet_another_ai.deskfleet.desktop", "icon.png", "LICENSE", "LICENSE.packaging"] as const

export async function packageAurRelease(
  directory: string,
  destination: string,
  archives: readonly string[],
  version = (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { version: string }).version,
): Promise<void> {
  if (archives.length === 0) throw new Error("Provide at least one Linux desktop archive")
  validateReleaseTag(`v${version}`, { root: version, desktop: version, cargo: version })
  const sources = new Map<string, { archive: string; filename: string; hash: string }>()
  for (const archive of archives) {
    const filename = basename(archive)
    const platform = Object.entries(architectures).find(([arch]) => filename === `deskfleet-${version}-linux-${arch}.tar.gz`)
    if (!platform) throw new Error(`Expected a deskfleet-${version}-linux-{x64,arm64}.tar.gz desktop archive; received ${filename}`)
    const arch = platform[1]
    if (sources.has(arch)) throw new Error(`Duplicate desktop archive for ${arch}`)
    const absolute = resolve(directory, archive)
    // electron-builder prefixes tar members with the archive's basename.
    const contents = new Set(execFileSync("tar", ["-tzf", absolute], { encoding: "utf8" }).split(/\r?\n/).map(path => path.replaceAll("/./", "/")))
    const prefix = filename.slice(0, -".tar.gz".length)
    for (const member of ["deskfleet", "chrome-sandbox", "resources/app.asar", "resources/app.asar.unpacked/out/main/deskfleet.node"]) {
      if (!contents.has(`${prefix}/${member}`)) throw new Error(`Desktop archive ${filename} is missing ${prefix}/${member}`)
    }
    const hash = createHash("sha256")
    for await (const chunk of createReadStream(absolute)) hash.update(chunk)
    sources.set(arch, { archive: absolute, filename, hash: hash.digest("hex") })
  }

  const inputs = new Map(helpers.map(filename => {
    const source = filename === "icon.png" ? "docs/content/public/logo.png"
      : filename === "LICENSE" ? "LICENSE" : `packaging/aur/${filename}`
    return [filename, readFileSync(join(directory, source))]
  }))
  const ordered = Object.values(architectures).filter(arch => sources.has(arch))
  const archiveSources = ordered.map(arch => {
    const source = sources.get(arch)!
    return `source_${arch}=('https://github.com/yet-another-ai/deskfleet/releases/download/v${version}/${source.filename}')\nsha256sums_${arch}=('${source.hash}')`
  }).join("\n")
  const template = readFileSync(join(directory, "packaging/aur/PKGBUILD.in"), "utf8")
  const pkgbuild = template
    .replaceAll("@PKGVER@", version.replaceAll("-", "_"))
    .replaceAll("@VERSION@", version)
    .replaceAll("@ARCHITECTURES@", ordered.map(arch => `'${arch}'`).join(" "))
    .replaceAll("@HELPER_HASHES@", helpers.map(filename => `'${createHash("sha256").update(inputs.get(filename)!).digest("hex")}'`).join("\n            "))
    .replaceAll("@ARCHIVE_SOURCES@", archiveSources)
  const output = resolve(directory, destination)
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, "PKGBUILD"), pkgbuild)
  for (const [filename, contents] of inputs) writeFileSync(join(output, filename), contents)
  // makepkg can verify local artifacts before a release is published. AUR sync
  // uploads only the recipe and helpers, never these cached binary archives.
  for (const source of sources.values()) {
    const target = join(output, source.filename)
    if (target !== source.archive) copyFileSync(source.archive, target)
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ options: { version: { type: "string" } }, allowPositionals: true })
  const [destination, ...archives] = positionals
  if (!destination || archives.length === 0) {
    throw new Error("Usage: node scripts/package-aur-release.ts [--version <version>] <output-dir> <desktop.tar.gz> [desktop.tar.gz ...]")
  }
  await packageAurRelease(process.cwd(), destination, archives, values.version)
  console.log(`Prepared AUR package: ${destination}`)
}
