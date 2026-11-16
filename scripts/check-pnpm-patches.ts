import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

export type PatchSelector =
  | { kind: "exact"; name: string; version: string }
  | { kind: "range"; name: string; range: string }
  | { kind: "name"; name: string }

export interface PatchedDependency {
  key: string
  path: string
  selector: PatchSelector
}

export interface PatchContractReport {
  ok: boolean
  errors: string[]
  warnings: string[]
  entries: PatchedDependency[]
}

const SCOPED = /^(@[^@/]+\/[^@/]+)(?:@(.+))?$/u
const UNSCOPED = /^([^@/]+)(?:@(.+))?$/u

/** Split a pnpm patchedDependencies key into package name and optional selector. */
export function parsePatchKey(key: string): PatchSelector {
  const scoped = SCOPED.exec(key)
  if (scoped) {
    const name = scoped[1]!
    const selector = scoped[2]
    if (!selector) return { kind: "name", name }
    if (/^[0-9]/u.test(selector) && !/[<>^*=| ]/u.test(selector)) {
      return { kind: "exact", name, version: selector }
    }
    return { kind: "range", name, range: selector }
  }
  const unscoped = UNSCOPED.exec(key)
  if (!unscoped) throw new Error(`unrecognized patchedDependencies key: ${key}`)
  const name = unscoped[1]!
  const selector = unscoped[2]
  if (!selector) return { kind: "name", name }
  if (/^[0-9]/u.test(selector) && !/[<>^*=| ]/u.test(selector)) {
    return { kind: "exact", name, version: selector }
  }
  return { kind: "range", name, range: selector }
}

/** Whether a selector survives a package version bump without becoming unused. */
export function selectorSurvivesVersionBump(selector: PatchSelector): boolean {
  return selector.kind !== "exact"
}

function parsePatchedDependencies(workspaceYaml: string): PatchedDependency[] {
  const lines = workspaceYaml.split(/\r?\n/u)
  const start = lines.findIndex(line => /^patchedDependencies:\s*$/u.test(line))
  if (start < 0) return []
  const entries: PatchedDependency[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\S/u.test(line)) break
    if (/^\s*$/u.test(line) || /^\s*#/u.test(line)) continue
    const match = /^\s+(?:'([^']+)'|"([^"]+)"|([^:]+)):\s*(.+?)\s*$/u.exec(line)
    if (!match) {
      throw new Error(`unable to parse patchedDependencies line: ${line}`)
    }
    const key = (match[1] ?? match[2] ?? match[3]!).trim()
    const path = (match[4] ?? "").replace(/^['"]|['"]$/gu, "")
    entries.push({ key, path, selector: parsePatchKey(key) })
  }
  return entries
}

function parseLockfilePatchKeys(lockfile: string): string[] {
  const lines = lockfile.split(/\r?\n/u)
  const start = lines.findIndex(line => /^patchedDependencies:\s*$/u.test(line))
  if (start < 0) return []
  const keys: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\S/u.test(line)) break
    if (/^\s*$/u.test(line) || /^\s*#/u.test(line)) continue
    const match = /^\s+(?:'([^']+)'|"([^"]+)"|([^:]+)):\s*/u.exec(line)
    if (!match) continue
    keys.push((match[1] ?? match[2] ?? match[3]!).trim())
  }
  return keys
}

function workspacePackageJsonPaths(repoRoot: string): string[] {
  const workspace = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8")
  const packages: string[] = []
  const lines = workspace.split(/\r?\n/u)
  const start = lines.findIndex(line => /^packages:\s*$/u.test(line))
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]!
      if (/^\S/u.test(line)) break
      const match = /^\s+-\s+(.+?)\s*$/u.exec(line)
      if (!match) continue
      packages.push(match[1]!.replace(/^['"]|['"]$/gu, ""))
    }
  }
  return [join(repoRoot, "package.json"), ...packages.map(dir => join(repoRoot, dir, "package.json"))]
}

function declaredDependencyVersions(repoRoot: string): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>()
  for (const manifestPath of workspacePackageJsonPaths(repoRoot)) {
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const deps = manifest[section]
      if (!deps || typeof deps !== "object") continue
      for (const [name, version] of Object.entries(deps as Record<string, string>)) {
        const set = versions.get(name) ?? new Set<string>()
        set.add(version)
        versions.set(name, set)
      }
    }
  }
  return versions
}

function lockfileResolvedVersions(lockfile: string, name: string): Set<string> {
  const versions = new Set<string>()
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const pattern = new RegExp(`^  (?:'${escaped}@([^']+)'|"${escaped}@([^"]+)"|${escaped}@([^:\\s(]+))`, "u")
  for (const line of lockfile.split(/\r?\n/u)) {
    const match = pattern.exec(line)
    if (!match) continue
    const version = match[1] ?? match[2] ?? match[3]
    if (version) versions.add(version.split("(")[0]!)
  }
  return versions
}

interface RenovateDisableRule {
  enabled: false
  matchPackageNames?: string[]
  matchManagers?: string[]
}

function disabledNpmPackageNames(renovateJson: string): Set<string> {
  const config = JSON.parse(renovateJson) as { packageRules?: RenovateDisableRule[] }
  const names = new Set<string>()
  for (const rule of config.packageRules ?? []) {
    if (rule.enabled !== false) continue
    const managers = rule.matchManagers
    if (managers && !managers.includes("npm")) continue
    for (const name of rule.matchPackageNames ?? []) names.add(name)
  }
  return names
}

function patchFilenames(repoRoot: string): string[] {
  const dir = join(repoRoot, "patches")
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.endsWith(".patch")).sort()
}

/**
 * Validate that pnpm patches stay usable across Renovate bumps:
 * exact pins must be Renovate-disabled; carry-across selectors (`@*` / ranges /
 * name-only) keep intended upgrades installable when the patch still applies.
 */
export function checkPnpmPatches(repoRoot = root): PatchContractReport {
  const errors: string[] = []
  const warnings: string[] = []
  const workspaceYaml = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8")
  const lockfile = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8")
  const renovateJson = readFileSync(join(repoRoot, "renovate.json"), "utf8")
  const entries = parsePatchedDependencies(workspaceYaml)
  const lockKeys = new Set(parseLockfilePatchKeys(lockfile))
  const declared = declaredDependencyVersions(repoRoot)
  const disabled = disabledNpmPackageNames(renovateJson)
  const referencedFiles = new Set<string>()

  if (entries.length === 0) {
    errors.push("pnpm-workspace.yaml declares no patchedDependencies")
  }

  for (const entry of entries) {
    referencedFiles.add(entry.path)
    const absolute = join(repoRoot, entry.path)
    if (!existsSync(absolute)) {
      errors.push(`missing patch file for ${entry.key}: ${entry.path}`)
    }
    if (!lockKeys.has(entry.key)) {
      errors.push(`pnpm-lock.yaml patchedDependencies is missing ${entry.key}`)
    }

    const { selector } = entry
    if (selector.kind === "exact") {
      const declaredVersions = declared.get(selector.name)
      if (declaredVersions && !declaredVersions.has(selector.version)) {
        errors.push(
          `exact patch ${entry.key} does not match declared dependency versions ` +
            `(${[...declaredVersions].sort().join(", ") || "none"})`,
        )
      }
      const resolved = lockfileResolvedVersions(lockfile, selector.name)
      if (resolved.size > 0 && !resolved.has(selector.version)) {
        errors.push(
          `exact patch ${entry.key} is unused: lockfile resolves ` +
            `${selector.name}@${[...resolved].sort().join(", ")}`,
        )
      }
      if (!disabled.has(selector.name)) {
        errors.push(
          `exact patch ${entry.key} must be Renovate-disabled in renovate.json ` +
            `(matchManagers: ["npm"], enabled: false), or retarget the key to ` +
            `${selector.name}@* so artifact refresh can reuse the patch when it still applies`,
        )
      }
    } else if (disabled.has(selector.name)) {
      warnings.push(
        `${entry.key} uses a carry-across selector but ${selector.name} is Renovate-disabled; ` +
          "prefer an exact pin for manually rebased adapter patches",
      )
    }

    const resolved = lockfileResolvedVersions(lockfile, selector.name)
    if (resolved.size === 0) {
      errors.push(`patched package ${selector.name} is absent from pnpm-lock.yaml`)
    }
  }

  for (const key of lockKeys) {
    if (!entries.some(entry => entry.key === key)) {
      errors.push(`pnpm-lock.yaml has patchedDependencies key ${key} absent from pnpm-workspace.yaml`)
    }
  }

  for (const file of patchFilenames(repoRoot)) {
    const relative = `patches/${file}`
    if (![...referencedFiles].includes(relative)) {
      errors.push(`orphan patch file ${relative} is not referenced by patchedDependencies`)
    }
  }

  return { ok: errors.length === 0, errors, warnings, entries }
}

function main(): void {
  const report = checkPnpmPatches()
  for (const warning of report.warnings) console.warn(`warning: ${warning}`)
  if (!report.ok) {
    for (const error of report.errors) console.error(`error: ${error}`)
    process.exitCode = 1
    return
  }
  const carry = report.entries.filter(entry => selectorSurvivesVersionBump(entry.selector)).length
  const exact = report.entries.length - carry
  console.log(
    `pnpm patch contract ok: ${report.entries.length} patches ` +
      `(${carry} carry-across for Renovate, ${exact} exact/manual)`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
}
