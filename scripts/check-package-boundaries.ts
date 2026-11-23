import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, posix } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

export interface WorkspacePackage {
  name: string
  /** Repository-relative POSIX directory. */
  dir: string
  /** Declared dependencies of every kind. */
  dependencies: Set<string>
}

export interface SourceFile {
  /** Repository-relative POSIX path. */
  path: string
  content: string
}

/** Contract packages run in the browser, Electron, and the daemon, so they stay leaves. */
export const PLATFORM_NEUTRAL_PACKAGES = new Set(["@deskfleet/protocol"])

// Tests, stories, fixtures, benchmarks, and tool configuration may reach into other
// packages' internals and run only under Node; shipped source goes through the
// owner's package exports. Every workspace import still needs a declared dependency.
const SUPPORT_FILE = /(?:\.(?:test|spec|stories)\.ts$|(?:^|\/)(?:fixtures|scripts|benchmarks|\.storybook|test)\/|\.config\.[cm]?ts$)/u
const SPECIFIER = /(?:\bfrom|\bimport\s*\(|^\s*import)\s*(["'])([^"'\n]+)\1/gmu
const WORKSPACE_SPECIFIER = /^(@deskfleet\/[a-z0-9-]+)(?:\/|$)/u

export function importSpecifiers(content: string): string[] {
  return [...content.matchAll(SPECIFIER)].map(match => match[2]!)
}

export function packageOf(packages: readonly WorkspacePackage[], path: string): WorkspacePackage | undefined {
  let owner: WorkspacePackage | undefined
  for (const candidate of packages) {
    if (path.startsWith(candidate.dir + "/") && (!owner || candidate.dir.length > owner.dir.length)) owner = candidate
  }
  return owner
}

/** Every import that crosses a package boundary without its declared public entry point. */
export function checkPackageBoundaries(packages: readonly WorkspacePackage[], files: readonly SourceFile[]): string[] {
  const errors: string[] = []
  const names = new Set(packages.map(pkg => pkg.name))
  for (const file of files) {
    const importer = packageOf(packages, file.path)
    if (!importer) continue
    const shipped = !SUPPORT_FILE.test(file.path)
    const neutral = shipped && PLATFORM_NEUTRAL_PACKAGES.has(importer.name)
    for (const specifier of importSpecifiers(file.content)) {
      if (specifier.startsWith(".")) {
        const owner = packageOf(packages, posix.normalize(posix.join(posix.dirname(file.path), specifier)))
        if (shipped && owner && owner !== importer) {
          errors.push(`${file.path}: import ${owner.name} by its package name instead of ${specifier}`)
        }
        continue
      }
      if (neutral && specifier.startsWith("node:")) {
        errors.push(`${file.path}: ${importer.name} is platform-neutral and cannot import ${specifier}`)
        continue
      }
      const workspace = WORKSPACE_SPECIFIER.exec(specifier)?.[1]
      if (!workspace || workspace === importer.name || !names.has(workspace)) continue
      if (neutral) errors.push(`${file.path}: ${importer.name} is a leaf package and cannot import ${workspace}`)
      else if (!importer.dependencies.has(workspace)) errors.push(`${file.path}: ${importer.name} must declare a dependency on ${workspace}`)
    }
  }
  return errors
}

function workspaceDirectories(directory: string): string[] {
  const manifest = readFileSync(join(directory, "pnpm-workspace.yaml"), "utf8").split(/\r?\n/u)
  const start = manifest.findIndex(line => /^packages:\s*$/u.test(line))
  const patterns: string[] = []
  for (const line of manifest.slice(start + 1)) {
    const entry = /^\s+-\s+['"]?([^'"#\s]+)['"]?\s*$/u.exec(line)
    if (!entry) break
    patterns.push(entry[1]!)
  }
  return patterns.flatMap(pattern => {
    if (!pattern.endsWith("/*")) return [pattern]
    const parent = pattern.slice(0, -2)
    return readdirSync(join(directory, parent), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(join(directory, parent, entry.name, "package.json")))
      .map(entry => `${parent}/${entry.name}`)
  })
}

export function loadWorkspace(directory: string): { packages: WorkspacePackage[]; files: SourceFile[] } {
  const packages = workspaceDirectories(directory).map(dir => {
    const manifest = JSON.parse(readFileSync(join(directory, dir, "package.json"), "utf8"))
    const dependencies = new Set([manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies].flatMap(group => Object.keys(group ?? {})))
    return { name: manifest.name as string, dir, dependencies }
  })
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.ts", "*.mts", "*.vue"], { cwd: directory, encoding: "utf8" }).split("\0").filter(Boolean)
  const files = tracked
    .filter(path => packageOf(packages, path) && existsSync(join(directory, path)))
    .map(path => ({ path, content: readFileSync(join(directory, path), "utf8") }))
  return { packages, files }
}

if (import.meta.main) {
  const { packages, files } = loadWorkspace(root)
  const errors = checkPackageBoundaries(packages, files)
  for (const error of errors) console.error(error)
  if (errors.length > 0) process.exit(1)
  console.log(`Package boundaries hold across ${files.length} files in ${packages.length} packages`)
}
