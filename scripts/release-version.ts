import { appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

interface ReleaseVersions {
  root: string
  desktop: string
  cargo: string
}

// Release versions also become OCI image tags, which do not allow SemVer's
// optional +build metadata. Numeric prerelease identifiers cannot start with 0.
const number = "(?:0|[1-9][0-9]*)"
const identifier = `(?:${number}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`
const releaseTag = new RegExp(`^v${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?$`, "u")

export function validateReleaseTag(tag: string, versions: ReleaseVersions): {
  tag: string
  version: string
  prerelease: boolean
} {
  if (!releaseTag.test(tag)) throw new Error("Release tag must be vMAJOR.MINOR.PATCH with an optional SemVer prerelease, without build metadata")
  const version = tag.slice(1)
  for (const [manifest, value] of Object.entries(versions)) {
    if (value !== version) throw new Error(`Tag ${tag} does not match ${manifest} version (${value})`)
  }
  return { tag, version, prerelease: version.includes("-") }
}

export function readReleaseVersions(directory: string): ReleaseVersions {
  const packageVersion = (path: string): string => JSON.parse(readFileSync(join(directory, path), "utf8")).version
  const cargo = readFileSync(join(directory, "Cargo.toml"), "utf8")
  const workspacePackage = cargo.split(/^\[workspace\.package\]\s*$/mu)[1]?.split(/^\[/mu)[0]
  const cargoVersion = workspacePackage?.match(/^version\s*=\s*"([^"]+)"\s*(?:#.*)?$/mu)?.[1]
  if (!cargoVersion) throw new Error("Cargo.toml must declare workspace.package.version")
  return {
    root: packageVersion("package.json"),
    desktop: packageVersion("apps/desktop/package.json"),
    cargo: cargoVersion,
  }
}

if (import.meta.main) {
  const release = validateReleaseTag(process.argv[2] ?? "", readReleaseVersions(process.cwd()))
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `tag=${release.tag}\nversion=${release.version}\nprerelease=${release.prerelease}\n`)
  }
  console.log(`Validated ${release.tag}${release.prerelease ? " (prerelease)" : ""}`)
}
