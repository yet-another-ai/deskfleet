import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import type { GitPreparationSnapshot } from "./git-protocol.ts"

const execute = promisify(execFile)
type Context = "worktree" | "directory"
interface Repository {
  root: string
  remote: string
  branch: string
  revision: string
  localRevision: string | null
  head: string
  status: string
  changes: string[]
  fingerprint: string
}

async function git(root: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[key]
  try {
    return (await execute("git", ["--no-pager", "-C", root, ...args], {
      encoding: "utf8", env, timeout: 20_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    })).stdout.replace(/\r?\n$/u, "")
  } catch (reason) {
    const error = reason as Error & { stderr?: string }
    throw new Error(`${root}: ${error.stderr?.trim() || error.message}`)
  }
}

async function revision(root: string, ref: string): Promise<string | null> {
  try { return await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) }
  catch { return null }
}

function changedPaths(status: string): string[] {
  const fields = status.split("\0")
  const paths = new Set<string>()
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!
    if (!field || field.startsWith("??") || field.startsWith("!!")) continue
    paths.add(field.slice(3))
    if (/[RC]/u.test(field.slice(0, 2))) paths.add(fields[++index]!)
  }
  return [...paths]
}

async function fetchDefault(root: string): Promise<Repository> {
  const remotes = (await git(root, ["remote"])).split(/\r?\n/u).filter(Boolean)
  const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0]! : undefined
  if (!remote || remote.startsWith("-")) throw new Error(`${root}: choose an origin remote or configure exactly one remote to prepare the default branch`)
  const advertised = await git(root, ["ls-remote", "--symref", "--", remote, "HEAD"])
  const branch = /^ref: refs\/heads\/(.+)\tHEAD$/mu.exec(advertised)?.[1]
  if (!branch) throw new Error(`${root}: the remote does not advertise a default branch`)
  await git(root, ["check-ref-format", "--branch", branch])
  const remoteRef = `refs/remotes/${remote}/${branch}`
  await git(root, ["fetch", "--no-tags", "--", remote, `+refs/heads/${branch}:${remoteRef}`])
  const fetched = await revision(root, remoteRef)
  if (!fetched) throw new Error(`${root}: the default branch has no committed HEAD`)
  return {
    root, remote, branch, revision: fetched, localRevision: await revision(root, `refs/heads/${branch}`),
    head: "", status: "", changes: [], fingerprint: "",
  }
}

async function inspectDirectory(repository: Repository): Promise<void> {
  const { root, branch, revision: target, localRevision } = repository
  repository.head = await git(root, ["rev-parse", "--verify", "HEAD"])
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    const path = resolve(root, await git(root, ["rev-parse", "--git-path", marker]))
    if (await stat(path).then(() => true, () => false)) throw new Error(`${root}: finish the current Git operation before preparing the directory`)
  }
  if (localRevision) {
    try { await git(root, ["merge-base", "--is-ancestor", localRevision, target]) }
    catch { throw new Error(`${root}: ${branch} has local commits that cannot be updated by fast-forward`) }
    const worktrees = (await git(root, ["worktree", "list", "--porcelain", "-z"])).split("\0\0")
    for (const worktree of worktrees) {
      const lines = worktree.split("\0")
      if (!lines.includes(`branch refs/heads/${branch}`)) continue
      const path = lines.find(line => line.startsWith("worktree "))?.slice(9)
      if (path && await realpath(path) !== root) throw new Error(`${root}: ${branch} is checked out in another worktree`)
    }
  }
  // Include ignored files: switch normally permits overwriting them, while this
  // operation promises to discard only the tracked changes shown to the user.
  const untracked = (await git(root, ["ls-files", "--others", "--directory", "--no-empty-directory", "-z"])).split("\0").filter(Boolean)
  if (untracked.length) {
    const tracked = new Set<string>()
    const parents = new Set<string>()
    const normalized = (path: string) => process.platform === "win32" ? path.toLowerCase() : path
    for (const ref of new Set([repository.head, target, ...(localRevision ? [localRevision] : [])])) {
      for (const value of (await git(root, ["ls-tree", "-r", "--name-only", "-z", ref])).split("\0").filter(Boolean)) {
        const path = normalized(value)
        tracked.add(path)
        for (let end = path.indexOf("/"); end !== -1; end = path.indexOf("/", end + 1)) parents.add(path.slice(0, end))
      }
    }
    const obstruction = untracked.find(value => {
      const path = normalized(value.replace(/\/$/u, ""))
      if (tracked.has(path) || parents.has(path)) return true
      for (let end = path.indexOf("/"); end !== -1; end = path.indexOf("/", end + 1)) {
        if (tracked.has(path.slice(0, end))) return true
      }
      return false
    })
    if (obstruction) throw new Error(`${root}: untracked or ignored file ${obstruction} would be overwritten; move it before preparing the directory`)
  }
  repository.status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  repository.changes = changedPaths(repository.status)
  const staged = await git(root, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"])
  const unstaged = await git(root, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--"])
  const currentBranch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")
  repository.fingerprint = createHash("sha256").update(JSON.stringify([
    repository.head, currentBranch, repository.status, staged, unstaged,
  ])).digest("hex")
}

async function prepare(workspaceId: string, directories: { path: string }[], context: Context, confirmationToken?: string): Promise<GitPreparationSnapshot> {
  const roots = new Map<string, Repository>()
  const bindings: { path: string; root: string }[] = []
  for (const directory of directories) {
    let root: string
    try { root = await realpath(await git(directory.path, ["rev-parse", "--show-toplevel"])) }
    catch (error) {
      if (context === "worktree") throw error
      continue
    }
    if (!roots.has(root)) roots.set(root, await fetchDefault(root))
    const subdirectory = relative(root, await realpath(directory.path)).split(sep).join("/")
    if (subdirectory) {
      const kind = await git(root, ["cat-file", "-t", `${roots.get(root)!.revision}:${subdirectory}`]).catch(() => "")
      if (kind !== "tree") throw new Error(`${directory.path}: the directory is absent from the default branch`)
    }
    bindings.push({ path: directory.path, root })
  }
  if (!roots.size) throw new Error("The Workspace has no Git repositories to prepare")
  const repositories = [...roots.values()]
  const snapshot = (): GitPreparationSnapshot => ({
    workspaceId, context, status: "ready",
    repositories: repositories.map(repository => ({ root: repository.root, branch: repository.branch, changes: repository.changes })),
  })
  if (context === "worktree") return {
    ...snapshot(), baseRevisions: bindings.map(binding => ({ path: binding.path, revision: roots.get(binding.root)!.revision })),
  }
  // Preflight every repository before modifying any source directory.
  for (const repository of repositories) await inspectDirectory(repository)
  const token = createHash("sha256").update(JSON.stringify({ workspaceId, context, directories,
    repositories: repositories.map(({ root, branch, revision, localRevision, fingerprint }) => ({ root, branch, revision, localRevision, fingerprint })),
  })).digest("hex")
  if (repositories.some(repository => repository.changes.length) && token !== confirmationToken) {
    return { ...snapshot(), status: "confirmation_required", confirmationToken: token }
  }
  for (const repository of repositories) {
    const { root, branch, revision: target, localRevision } = repository
    if (repository.changes.length) await git(root, ["reset", "--hard", "HEAD"])
    if (localRevision) await git(root, ["switch", "--no-overwrite-ignore", branch])
    else await git(root, ["switch", "--no-overwrite-ignore", "--create", branch, "--track", `${repository.remote}/${branch}`])
    await git(root, ["merge", "--ff-only", target])
    repository.changes = []
  }
  return snapshot()
}

// Preparation can touch shared workspace directories. Serialize requests from
// this daemon so another viewer cannot interleave a second reset/switch sequence.
let preparing: Promise<unknown> = Promise.resolve()
export function prepareGitWorkspace(workspaceId: string, directories: { path: string }[], context: Context, confirmationToken?: string): Promise<GitPreparationSnapshot> {
  const pending = preparing.catch(() => {}).then(() => prepare(workspaceId, directories, context, confirmationToken))
  preparing = pending
  return pending
}
