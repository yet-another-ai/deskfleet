import { stat } from "node:fs/promises"
import { join } from "node:path"
import { executeGit } from "./git-execution.ts"

export type WorktreeLocalChanges = "uncommitted" | "all" | "none"

export interface WorktreeCleanupRepository {
  path: string
  revision?: string
  branch?: string
  defaultBranch?: string
  defaultRevision?: string
  includedInDefault: boolean
}

export interface WorktreeCleanupInspection {
  hasCheckouts: boolean
  protected: boolean
  repositories: WorktreeCleanupRepository[]
}

/** Stable Git identity carried from eligibility checks through final removal. */
export function worktreeCleanupFingerprint(inspection: WorktreeCleanupInspection): string {
  return JSON.stringify(inspection.repositories.map(repository => [
    repository.path, repository.revision ?? null, repository.branch ?? null,
    repository.defaultBranch ?? null, repository.defaultRevision ?? null,
  ]))
}

async function git(path: string, args: string[]): Promise<string> {
  return (await executeGit(["-C", path, ...args], {
    optionalLocks: false, maxBuffer: 1024 * 1024,
  })).stdout.replace(/\r?\n$/u, "")
}

async function optionalGit(path: string, args: string[]): Promise<string | undefined> {
  try { return await git(path, args) }
  catch (error) {
    if ((error as { code?: number }).code === 1) return undefined
    throw error
  }
}

async function hasLocalChanges(path: string, protection: WorktreeLocalChanges): Promise<boolean> {
  if (protection === "none") return false
  const status = await git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none",
    ...(protection === "all" ? ["--ignored=matching"] : [])])
  if (status) return true
  if (protection !== "all") return false
  // The parent status reports submodule edits, but not ignored files inside it.
  for (const entry of (await git(path, ["ls-files", "--stage", "-z"])).split("\0")) {
    if (!entry.startsWith("160000 ")) continue
    const submodule = join(path, entry.slice(entry.indexOf("\t") + 1))
    if (await stat(join(submodule, ".git")).then(() => true, error => {
      if (error.code === "ENOENT") return false
      throw error
    }) && await hasLocalChanges(submodule, protection)) return true
  }
  return false
}

async function defaultReference(path: string): Promise<{ name: string; revision: string } | undefined> {
  const remotes = (await git(path, ["remote"])).split(/\r?\n/u).filter(Boolean)
  const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined
  if (remote) {
    // Use the repository's recorded remote default, never guess from a feature
    // checkout's HEAD. A missing default leaves ancestry cleanup ineligible.
    const reference = await optionalGit(path, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`])
    const revision = reference && await optionalGit(path, ["rev-parse", "--verify", "--quiet", `${reference}^{commit}`])
    if (reference && revision) return { name: reference, revision }
    return undefined
  }
  if (remotes.length) return undefined
  for (const branch of ["main", "master"]) {
    const reference = `refs/heads/${branch}`
    const revision = await optionalGit(path, ["rev-parse", "--verify", "--quiet", `${reference}^{commit}`])
    if (revision) return { name: reference, revision }
  }
  return undefined
}

/** Refresh only the advertised default ref; never switch or reset a checkout. */
export async function refreshWorktreeCleanupDefaults(paths: string[]): Promise<void> {
  for (const path of paths) {
    const remotes = (await git(path, ["remote"])).split(/\r?\n/u).filter(Boolean)
    if (!remotes.length) continue
    const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined
    if (!remote || remote.startsWith("-")) throw new Error(`${path}: default remote is ambiguous`)
    const advertised = await git(path, ["ls-remote", "--symref", "--", remote, "HEAD"])
    const branch = /^ref: refs\/heads\/(.+)\tHEAD$/mu.exec(advertised)?.[1]
    if (!branch) throw new Error(`${path}: remote does not advertise a default branch`)
    await git(path, ["check-ref-format", `refs/heads/${branch}`])
    const reference = `refs/remotes/${remote}/${branch}`
    await git(path, ["fetch", "--no-tags", "--", remote, `+refs/heads/${branch}:${reference}`])
    await git(path, ["symbolic-ref", `refs/remotes/${remote}/HEAD`, reference])
  }
}

/** Missing, unreadable, or unrecognized Git state never implies a clean tree. */
export async function inspectWorktreeCleanup(paths: string[], protection: WorktreeLocalChanges): Promise<WorktreeCleanupInspection> {
  const inspection: WorktreeCleanupInspection = { hasCheckouts: false, protected: false, repositories: [] }
  for (const path of paths) {
    const exists = await stat(path).then(() => true, error => {
      if (error.code === "ENOENT") return false
      throw error
    })
    if (!exists) {
      inspection.repositories.push({ path, includedInDefault: false })
      continue
    }
    inspection.hasCheckouts = true
    inspection.protected ||= await hasLocalChanges(path, protection)
    const reference = await optionalGit(path, ["symbolic-ref", "--quiet", "HEAD"])
    const revision = await git(path, ["rev-parse", "--verify", "HEAD"])
    const defaultRef = await defaultReference(path)
    const includedInDefault = defaultRef !== undefined
      && await optionalGit(path, ["merge-base", "--is-ancestor", revision, defaultRef.revision]) !== undefined
    inspection.repositories.push({
      path, revision,
      ...(reference?.startsWith("refs/heads/") ? { branch: reference.slice("refs/heads/".length) } : {}),
      ...(defaultRef ? { defaultBranch: defaultRef.name.replace(/^refs\/(heads|remotes)\//u, ""), defaultRevision: defaultRef.revision } : {}),
      includedInDefault,
    })
  }
  return inspection
}
