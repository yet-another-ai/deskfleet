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
    /^scripts\/(?:package-|check-aur|smoke-linux-package|stage-native-binaries)/u.test(path) ||
    /^\.github\/workflows\/(?:build|nix|aur|aur-publish)\.yml$/u.test(path) ||
    path === "apps/desktop/package.json" ||
    /^apps\/desktop\/electron-builder(?:\.release)?\.yml$/u.test(path) ||
    path.startsWith("apps/desktop/build/") ||
    /^apps\/desktop\/scripts\/stage-/u.test(path)
}

export function hasPackagingChanges(raw: string): boolean {
  const records = raw.split("\0")
  if (records.pop() !== "" || records.length === 0 || records.length % 2 !== 0) return true
  for (let i = 0; i < records.length; i += 2) {
    const file = records[i + 1] ?? ""
    if (isPackagingPath(file)) return true
  }
  return false
}

export interface ClassificationResult {
  docsOnly: boolean
  runBuild: boolean
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
      if (!commit(source) || !commit(target)) return { docsOnly: false, runBuild: true }
      head = source
      base = git("merge-base", target, source).trim()
      if (!commit(base)) return { docsOnly: false, runBuild: true }
    } else if (eventName === "push" && ref === "refs/heads/main") {
      if (!commit(event.before) || !commit(event.after)) return { docsOnly: false, runBuild: true }
      base = event.before
      head = event.after
    } else {
      return { docsOnly: false, runBuild: true }
    }
    // Disabling rename detection ensures moving code into docs still checks its deletion.
    const raw = git("diff", "--raw", "--no-abbrev", "--no-renames", "-z", base, head, "--")
    const docsOnly = isDocumentationDiff(raw)
    if (docsOnly) {
      return { docsOnly: true, runBuild: false }
    }
    if (isPr) {
      if (isDraft) {
        return { docsOnly: false, runBuild: false }
      }
      return { docsOnly: false, runBuild: hasPackagingChanges(raw) }
    }
    return { docsOnly: false, runBuild: true }
  } catch {
    return { docsOnly: false, runBuild: true }
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
  let runBuild = true
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")) as ChangeEvent
    const res = classifyChanges(process.env.GITHUB_EVENT_NAME ?? "", process.env.GITHUB_REF ?? "", event)
    docsOnly = res.docsOnly
    runBuild = res.runBuild
  } catch {
    // Missing events and unavailable history never justify skipping validation.
  }
  console.log(
    docsOnly
      ? "Documentation change: static checks remain required."
      : runBuild
        ? "Running full CI and packaging build."
        : "Running CI checks; skipping packaging build."
  )
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${docsOnly}\nrun_build=${runBuild}\n`)
  }
}
