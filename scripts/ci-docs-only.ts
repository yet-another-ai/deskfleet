import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"

interface ChangeEvent {
  before?: string
  after?: string
  pull_request?: { base?: { sha?: string }; head?: { sha?: string }; draft?: boolean }
}

function commit(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value) && /[1-9a-f]/u.test(value)
}

function documentation(path: string): boolean {
  return ["README.md", "AGENTS.md", "CONTRIBUTING.md"].includes(path) ||
    /^(?:agents\/docs|docs)\/.+\.md$/u.test(path)
}

export function isDocumentationDiff(raw: string): boolean {
  // Raw, NUL-delimited records retain both file modes and unusual filenames.
  const records = raw.split("\0")
  if (records.pop() !== "" || records.length === 0 || records.length % 2 !== 0) return false
  for (let i = 0; i < records.length; i += 2) {
    const metadata = records[i] ?? ""
    const file = records[i + 1] ?? ""
    if (!/^:(100644|000000) (100644|000000) [0-9a-f]{40} [0-9a-f]{40} [AMD]$/u.test(metadata) ||
        !documentation(file)) return false
  }
  return true
}

export function isPackagingPath(path: string): boolean {
  return /^(?:packaging|nix)\//u.test(path) ||
    /^(?:flake\.nix|flake\.lock)$/u.test(path) ||
    /^scripts\/(?:package-|check-(?:aur|linux-release)|smoke-linux-package|stage-native-binaries|build-(?:android|ios)-viewer\.ts)/u.test(path) ||
    /^scripts\/(?:app-store-connect|prepare-ios-signing|publish-ios-release)\.ts$/u.test(path) ||
    /^\.github\/workflows\/(?:build|nix|nix-server|aur|aur-publish|linux-packages)\.yml$/u.test(path) ||
    path === "apps/desktop/package.json" ||
    path === "apps/web/capacitor.config.ts" ||
    path.startsWith("apps/web/android/") ||
    path.startsWith("apps/web/ios/") ||
    path.startsWith("packages/capacitor-bridge/") ||
    // `nix/web.nix` installs these pnpm inputs for the offline Web image build.
    /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u.test(path) ||
    /^(?:apps\/(?:web|daemon)|packages\/(?:client|components))\/package\.json$/u.test(path) ||
    // `nix/toolchain.nix` reads both files to build the Node and pnpm tools.
    /^(?:mise\.toml|mise\.ci\.toml|mise\.lock)$/u.test(path) ||
    path.startsWith("patches/") ||
    /^apps\/desktop\/electron-builder(?:\.release)?\.yml$/u.test(path) ||
    path.startsWith("apps/desktop/build/") ||
    /^apps\/desktop\/scripts\/stage-/u.test(path)
}

export function hasMatchingChanges(raw: string, matcher: (path: string) => boolean): boolean {
  const records = raw.split("\0")
  if (records.pop() !== "" || records.length === 0 || records.length % 2 !== 0) return true
  for (let i = 0; i < records.length; i += 2) {
    const file = records[i + 1] ?? ""
    if (matcher(file)) return true
  }
  return false
}

export function isPlatformPath(path: string): boolean {
  return path.endsWith(".rs") ||
    /^(?:crates|apps\/desktop|apps\/desktop-service|apps\/daemon|apps\/web\/(?:android|ios)|packages\/capacitor-bridge|packages\/client|packages\/mcp|packages\/dsh-runtime|vendor)\//u.test(path) ||
    path === "apps/web/capacitor.config.ts" ||
    /^(?:Cargo\.toml|Cargo\.lock|mise\.toml|mise\.ci\.toml|mise\.lock|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u.test(path) ||
    /^(?:\.github\/(?:workflows|actions)|scripts)\//u.test(path) ||
    path.startsWith(".config/build-env/") ||
    path.startsWith("patches/")
}

export function isBackendPath(path: string): boolean {
  return path.endsWith(".rs") ||
    /^(?:apps\/server|apps\/daemon|apps\/desktop|crates|packages\/mcp|packages\/client|packages\/dsh-runtime|vendor)\//u.test(path) ||
    /^(?:Cargo\.toml|Cargo\.lock|compose\.yaml|mise\.toml|mise\.ci\.toml|mise\.lock|package\.json|pnpm-lock\.yaml)$/u.test(path) ||
    /^(?:\.github\/(?:workflows|actions)|scripts)\//u.test(path) ||
    path.startsWith(".config/build-env/") ||
    path.startsWith("patches/")
}

export function hasPackagingChanges(raw: string): boolean {
  return hasMatchingChanges(raw, isPackagingPath)
}

export function hasPlatformChanges(raw: string): boolean {
  return hasMatchingChanges(raw, isPlatformPath)
}

export function hasBackendChanges(raw: string): boolean {
  return hasMatchingChanges(raw, isBackendPath)
}

export function isSpecPath(path: string): boolean {
  return /^specs\/[^/]+\.qnt$/u.test(path)
}

function ordinaryRecord(metadata: string): boolean {
  return /^:(100644|000000) (100644|000000) [0-9a-f]{40} [0-9a-f]{40} [AMD]$/u.test(metadata)
}

/** A diff of Quint models, optionally with documentation. Any other path is a full change. */
export function isSpecsOnlyDiff(raw: string): boolean {
  const records = raw.split("\0")
  if (records.pop() !== "" || records.length === 0 || records.length % 2 !== 0) return false
  let sawSpec = false
  for (let i = 0; i < records.length; i += 2) {
    const metadata = records[i] ?? ""
    const file = records[i + 1] ?? ""
    if (!ordinaryRecord(metadata)) return false
    if (isSpecPath(file)) sawSpec = true
    else if (!documentation(file)) return false
  }
  return sawSpec
}

const fullValidation = { docsOnly: false, specsOnly: false, runBuild: true, allPlatforms: true, runBackend: true }

export interface ClassificationResult {
  docsOnly: boolean
  specsOnly: boolean
  runBuild: boolean
  allPlatforms: boolean
  runBackend: boolean
}

export function classifyChanges(
  eventName: string,
  ref: string,
  event: ChangeEvent,
  cwd = process.cwd()
): ClassificationResult {
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  })
  try {
    let base: string
    let head: string
    let isPr = false
    let isDraft = false
    if (eventName === "pull_request") {
      isPr = true
      isDraft = Boolean(event.pull_request?.draft)
      const source = event.pull_request?.head?.sha
      const target = event.pull_request?.base?.sha
      if (!commit(source) || !commit(target)) return fullValidation
      head = source
      base = git("merge-base", target, source).trim()
      if (!commit(base)) return fullValidation
    } else if (eventName === "push" && ref === "refs/heads/main") {
      if (!commit(event.before) || !commit(event.after)) return fullValidation
      base = event.before
      head = event.after
    } else {
      return fullValidation
    }
    // Disabling rename detection ensures moving code into docs still checks its deletion.
    const raw = git("diff", "--raw", "--no-abbrev", "--no-renames", "-z", base, head, "--")
    const docsOnly = isDocumentationDiff(raw)
    if (docsOnly) {
      return { docsOnly: true, specsOnly: false, runBuild: false, allPlatforms: false, runBackend: false }
    }
    // Model edits skip the product suites. Packaging stays off because mise files are not spec paths.
    if (isSpecsOnlyDiff(raw)) {
      return { docsOnly: false, specsOnly: true, runBuild: false, allPlatforms: false, runBackend: false }
    }
    if (isPr) {
      if (isDraft) {
        return { docsOnly: false, specsOnly: false, runBuild: false, allPlatforms: false, runBackend: false }
      }
      return {
        docsOnly: false,
        specsOnly: false,
        runBuild: hasPackagingChanges(raw),
        allPlatforms: hasPlatformChanges(raw),
        runBackend: hasBackendChanges(raw),
      }
    }
    return fullValidation
  } catch {
    return fullValidation
  }
}

export function classifyDocumentation(
  eventName: string,
  ref: string,
  event: ChangeEvent,
  cwd = process.cwd()
): boolean {
  return classifyChanges(eventName, ref, event, cwd).docsOnly
}

if (import.meta.main) {
  let docsOnly = false
  let specsOnly = false
  let runBuild = true
  let allPlatforms = true
  let runBackend = true
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")) as ChangeEvent
    const res = classifyChanges(process.env.GITHUB_EVENT_NAME ?? "", process.env.GITHUB_REF ?? "", event)
    docsOnly = res.docsOnly
    specsOnly = res.specsOnly
    runBuild = res.runBuild
    allPlatforms = res.allPlatforms
    runBackend = res.runBackend
  } catch {
    // Missing events and unavailable history never justify skipping validation.
  }
  console.log(
    docsOnly
      ? "Documentation change: static checks remain required."
      : specsOnly
        ? "Spec change: preflight runs spec:test and skips static checks, runtime suites, and packaging."
        : [
            `Running CI:`,
            `platforms=${allPlatforms ? "all (Linux, Windows, macOS)" : "Linux only"}`,
            `backend=${runBackend ? "yes" : "skip"}`,
            `packaging_build=${runBuild ? "yes" : "skip"}`,
          ].join(" ")
  )
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `docs_only=${docsOnly}\nspecs_only=${specsOnly}\nrun_build=${runBuild}\nall_platforms=${allPlatforms}\nrun_backend=${runBackend}\n`
    )
  }
}
