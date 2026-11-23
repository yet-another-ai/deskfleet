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
    /^scripts\/(?:package-(?:aur|linux|nix)-release|check-(?:aur|linux-release)|smoke-linux-package|stage-native-binaries|windows-service-signing)\.ts$/u.test(path) ||
    /^\.github\/workflows\/(?:build|publish|nix|aur|aur-publish|linux-packages)\.yml$/u.test(path) ||
    path === "apps/desktop/package.json" ||
    path === "apps/server/Dockerfile" ||
    path.startsWith("apps/super-agent/") ||
    path.startsWith("apps/server/src/cloud_agent/") ||
    path === "tsconfig.json" ||
    /^scripts\/smoke-(?:server|super-agent)-image\.ts$/u.test(path) ||
    path === "scripts/fixtures/image-smoke.ts" ||
    /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u.test(path) ||
    /^(?:apps\/(?:web|daemon)|packages\/(?:client|components))\/package\.json$/u.test(path) ||
    /^(?:mise\.toml|mise\.ci\.toml|mise\.lock)$/u.test(path) ||
    path.startsWith("patches/") ||
    /^apps\/desktop\/electron-builder(?:\.release)?\.yml$/u.test(path) ||
    path.startsWith("apps/desktop/build/") ||
    /^apps\/desktop\/scripts\/stage-/u.test(path)
}

export function isNixServerPath(path: string): boolean {
  return /^(?:flake\.nix|flake\.lock)$/u.test(path) ||
    path.startsWith("nix/") ||
    path === ".github/workflows/nix-server.yml" ||
    path === "scripts/smoke-server-image.ts" ||
    path === "scripts/fixtures/image-smoke.ts" ||
    // `nix/server.nix` filesets the workspace Cargo metadata, server/backend crates, and vendored pty patch.
    /^(?:Cargo\.toml|Cargo\.lock)$/u.test(path) ||
    /^(?:apps|crates)\/[^/]+\/(?:Cargo\.toml|build\.rs|src\/(?:lib|main)\.rs)$/u.test(path) ||
    path.startsWith("apps/server/src/") ||
    path === "packages/mcp/src/remote-tools.json" ||
    /^(?:crates\/(?:control-store|model|protocol)\/src|vendor\/portable-pty)\//u.test(path) ||
    // `nix/web.nix` installs from these pnpm lock/manifest/build-config inputs and `nix/toolchain.nix` reads mise.
    /^(?:tsconfig\.json|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|mise\.toml|mise\.lock)$/u.test(path) ||
    /^(?:apps\/(?:web|daemon)|packages\/(?:capacitor-bridge|client|components|protocol))\/package\.json$/u.test(path) ||
    /^apps\/web\/(?:index\.html|tsconfig\.json|vite\.config\.ts)$/u.test(path) ||
    path === "packages/components/uno.config.ts" ||
    path.startsWith("patches/")
}

export function isSuperAgentPath(path: string): boolean {
  return path.startsWith("apps/super-agent/") ||
    path.startsWith("apps/server/src/cloud_agent/") ||
    /^nix\/(?:super-agent|toolchain\.nix|container-runtime\.nix|import-pnpm-lock\/)/u.test(path) ||
    /^(?:flake\.nix|flake\.lock)$/u.test(path) ||
    path === "scripts/smoke-super-agent-image.ts" ||
    path === "scripts/fixtures/image-smoke.ts" ||
    /^\.github\/workflows\/(?:build|publish)\.yml$/u.test(path) ||
    /^(?:tsconfig\.json|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|mise\.toml|mise\.lock)$/u.test(path) ||
    path.startsWith("patches/")
}

export function isAndroidPath(path: string): boolean {
  return path.startsWith("apps/web/android/") ||
    path === "apps/web/capacitor.config.ts" ||
    path.startsWith("packages/capacitor-bridge/") ||
    path.startsWith("crates/desktop-viewer/") ||
    path.startsWith("crates/viewer-controls/") ||
    /^scripts\/(?:build-android-viewer|prepare-android-nsh)\.ts$/u.test(path) ||
    path.startsWith(".github/actions/setup-gradle-mirror/") ||
    path.startsWith(".github/actions/setup-build/") ||
    path.startsWith(".github/actions/setup-mise/") ||
    /^\.github\/workflows\/(?:build|test|publish)\.yml$/u.test(path) ||
    /^(?:Cargo\.toml|Cargo\.lock|mise\.toml|mise\.ci\.toml|mise\.lock|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u.test(path)
}

export function isIosPath(path: string): boolean {
  return path.startsWith("apps/web/ios/") ||
    path === "apps/web/capacitor.config.ts" ||
    path.startsWith("packages/capacitor-bridge/") ||
    path.startsWith("crates/desktop-viewer/") ||
    path.startsWith("crates/viewer-controls/") ||
    /^scripts\/(?:build-ios-viewer|package-ios-release|app-store-connect|prepare-ios-signing|publish-ios-release)\.ts$/u.test(path) ||
    path.startsWith(".github/actions/setup-build/") ||
    path.startsWith(".github/actions/setup-mise/") ||
    /^\.github\/workflows\/(?:build|test|publish)\.yml$/u.test(path) ||
    /^(?:Cargo\.toml|Cargo\.lock|mise\.toml|mise\.ci\.toml|mise\.lock|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u.test(path)
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
    /^(?:crates|apps\/desktop|apps\/desktop-service|apps\/maintenance-service|apps\/daemon|apps\/web\/(?:android|ios)|packages\/agents|packages\/capacitor-bridge|packages\/client|packages\/mcp|packages\/dsh-runtime|vendor)\//u.test(path) ||
    path === "apps/web/capacitor.config.ts" ||
    /^(?:Cargo\.toml|Cargo\.lock|mise\.toml|mise\.ci\.toml|mise\.lock|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u.test(path) ||
    /^(?:\.github\/(?:workflows|actions)|scripts)\//u.test(path) ||
    path.startsWith(".config/build-env/") ||
    path.startsWith("patches/")
}

export function isBackendPath(path: string): boolean {
  return path.endsWith(".rs") ||
    /^(?:apps\/server|apps\/daemon|apps\/desktop|crates|packages\/agents|packages\/mcp|packages\/client|packages\/dsh-runtime|vendor)\//u.test(path) ||
    /^(?:Cargo\.toml|Cargo\.lock|compose\.yaml|mise\.toml|mise\.ci\.toml|mise\.lock|package\.json|pnpm-lock\.yaml)$/u.test(path) ||
    /^(?:\.github\/(?:workflows|actions)|scripts)\//u.test(path) ||
    path.startsWith(".config/build-env/") ||
    path.startsWith("patches/")
}

export function hasPackagingChanges(raw: string): boolean {
  return hasMatchingChanges(raw, isPackagingPath)
}

export function hasNixServerChanges(raw: string): boolean {
  return hasMatchingChanges(raw, isNixServerPath)
}

export function hasSuperAgentChanges(raw: string): boolean {
  return hasMatchingChanges(raw, isSuperAgentPath)
}

export function hasAndroidChanges(raw: string): boolean {
  return hasMatchingChanges(raw, isAndroidPath)
}

export function hasIosChanges(raw: string): boolean {
  return hasMatchingChanges(raw, isIosPath)
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

/** Quint models may include repository documentation, but website edits need their build. */
export function isSpecsOnlyDiff(raw: string): boolean {
  const records = raw.split("\0")
  if (records.pop() !== "" || records.length === 0 || records.length % 2 !== 0) return false
  let sawSpec = false
  for (let i = 0; i < records.length; i += 2) {
    const metadata = records[i] ?? ""
    const file = records[i + 1] ?? ""
    if (!ordinaryRecord(metadata)) return false
    if (isSpecPath(file)) sawSpec = true
    else if (file.startsWith("docs/") || !documentation(file)) return false
  }
  return sawSpec
}

const fullValidation: ClassificationResult = {
  docsOnly: false,
  specsOnly: false,
  runBuild: true,
  runNixServer: true,
  runSuperAgent: true,
  runAndroid: true,
  runIos: true,
  allPlatforms: true,
  runBackend: true,
}

const skipAllSuites = {
  runBuild: false,
  runNixServer: false,
  runSuperAgent: false,
  runAndroid: false,
  runIos: false,
  allPlatforms: false,
  runBackend: false,
}

export interface ClassificationResult {
  docsOnly: boolean
  specsOnly: boolean
  runBuild: boolean
  runNixServer: boolean
  runSuperAgent: boolean
  runAndroid: boolean
  runIos: boolean
  allPlatforms: boolean
  runBackend: boolean
}

export interface ClassifyOptions {
  /** Last passing main CI commit SHA; expands main push diffs across cancelled/failed intermediate runs. */
  mainBaseSha?: string
  /** Require a valid mainBaseSha on main pushes; if missing, fail closed to fullValidation. */
  requireMainBaseSha?: boolean
}

export function classifyChanges(
  eventName: string,
  ref: string,
  event: ChangeEvent,
  cwd = process.cwd(),
  options: ClassifyOptions = {},
): ClassificationResult {
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  })
  const isAncestor = (ancestor: string, descendant: string): boolean => {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
        cwd, stdio: ["ignore", "ignore", "ignore"]
      })
      return true
    } catch {
      return false
    }
  }
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
      if (options.requireMainBaseSha || options.mainBaseSha !== undefined) {
        if (!commit(options.mainBaseSha) || !isAncestor(options.mainBaseSha, head)) {
          return fullValidation
        }
        if (isAncestor(options.mainBaseSha, base)) {
          base = options.mainBaseSha
        }
      }
    } else {
      return fullValidation
    }
    // Disabling rename detection ensures moving code into docs still checks its deletion.
    const raw = git("diff", "--raw", "--no-abbrev", "--no-renames", "-z", base, head, "--")
    const docsOnly = isDocumentationDiff(raw)
    if (docsOnly) {
      return { docsOnly: true, specsOnly: false, ...skipAllSuites }
    }
    // Model edits skip the product suites. Packaging stays off because mise files are not spec paths.
    if (isSpecsOnlyDiff(raw)) {
      return { docsOnly: false, specsOnly: true, ...skipAllSuites }
    }
    if (isPr && isDraft) {
      return { docsOnly: false, specsOnly: false, ...skipAllSuites }
    }
    return {
      docsOnly: false,
      specsOnly: false,
      runBuild: hasPackagingChanges(raw),
      runNixServer: hasNixServerChanges(raw),
      runSuperAgent: hasSuperAgentChanges(raw),
      runAndroid: hasAndroidChanges(raw),
      runIos: hasIosChanges(raw),
      allPlatforms: hasPlatformChanges(raw),
      runBackend: hasBackendChanges(raw),
    }
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
  let res: ClassificationResult = { ...fullValidation }
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")) as ChangeEvent
    const requireMainBaseSha = process.env.CI_REQUIRE_MAIN_BASE_SHA === "1"
    const mainBaseSha = process.env.CI_MAIN_BASE_SHA?.trim() || undefined
    res = classifyChanges(
      process.env.GITHUB_EVENT_NAME ?? "",
      process.env.GITHUB_REF ?? "",
      event,
      process.cwd(),
      requireMainBaseSha || mainBaseSha ? { mainBaseSha, requireMainBaseSha } : {},
    )
  } catch {
    // Missing events and unavailable history never justify skipping validation.
  }
  console.log(
    res.docsOnly
      ? "Documentation change: static checks remain required."
      : res.specsOnly
        ? "Spec change: preflight runs spec:test and skips static checks, runtime suites, and packaging."
        : [
            `Running CI:`,
            `platforms=${res.allPlatforms ? "all (Linux, Windows, macOS)" : "Linux only"}`,
            `backend=${res.runBackend ? "yes" : "skip"}`,
            `android=${res.runAndroid ? "yes" : "skip"}`,
            `ios=${res.runIos ? "yes" : "skip"}`,
            `packaging_build=${res.runBuild ? "yes" : "skip"}`,
            `super_agent=${res.runSuperAgent ? "yes" : "skip"}`,
            `nix_server=${res.runNixServer ? "yes" : "skip"}`,
          ].join(" ")
  )
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `docs_only=${res.docsOnly}`,
        `specs_only=${res.specsOnly}`,
        `run_build=${res.runBuild}`,
        `run_nix_server=${res.runNixServer}`,
        `run_super_agent=${res.runSuperAgent}`,
        `run_android=${res.runAndroid}`,
        `run_ios=${res.runIos}`,
        `all_platforms=${res.allPlatforms}`,
        `run_backend=${res.runBackend}`,
      ].join("\n") + "\n"
    )
  }
}
