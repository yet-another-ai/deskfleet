import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

const targets = [
  { system: "x86_64-linux", suffix: "linux-x64.tar.gz" },
  { system: "aarch64-linux", suffix: "linux-arm64.tar.gz" },
  { system: "aarch64-darwin", suffix: "mac-arm64.zip" },
] as const

export async function packageNixRelease(directory: string, destination: string, archives: readonly string[]): Promise<void> {
  if (archives.length === 0) throw new Error("Provide at least one desktop archive")
  const { version } = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { version: string }
  const sources: Record<string, { url: string; hash: string }> = {}
  for (const archive of archives) {
    const filename = basename(archive)
    const target = targets.find(({ suffix }) => filename === `deskfleet-${version}-${suffix}`)
    if (!target) {
      throw new Error(
        `Expected a deskfleet-${version}-linux-{x64,arm64}.tar.gz or deskfleet-${version}-mac-arm64.zip desktop archive; received ${filename}`,
      )
    }
    if (sources[target.system]) throw new Error(`Duplicate desktop archive for ${target.system}`)
    const hash = createHash("sha256")
    for await (const chunk of createReadStream(resolve(directory, archive))) hash.update(chunk)
    sources[target.system] = {
      url: `https://github.com/yet-another-ai/deskfleet/releases/download/v${version}/${filename}`,
      hash: `sha256-${hash.digest("base64")}`,
    }
  }

  const temporary = mkdtempSync(join(tmpdir(), "deskfleet-nix-release-"))
  try {
    const staged = join(temporary, "deskfleet-nix")
    mkdirSync(staged)
    for (const filename of ["flake.nix", "flake.lock", "desktop.nix", "desktop-darwin.nix"]) {
      copyFileSync(join(directory, "nix", filename), join(staged, filename))
    }
    copyFileSync(join(directory, "apps/desktop/build/icon.png"), join(staged, "icon.png"))
    writeFileSync(join(staged, "release.json"), JSON.stringify({ version, sources }, null, 2) + "\n")
    const output = resolve(directory, destination)
    mkdirSync(dirname(output), { recursive: true })
    execFileSync("tar", ["-czf", output, "-C", temporary, "deskfleet-nix"], { stdio: "inherit" })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const [destination, ...archives] = process.argv.slice(2)
  if (!destination || archives.length === 0) {
    throw new Error("Usage: node scripts/package-nix-release.ts <output.tar.gz> <desktop archive> [desktop archive ...]")
  }
  await packageNixRelease(process.cwd(), destination, archives)
  console.log(`Packaged Nix release: ${destination}`)
}
