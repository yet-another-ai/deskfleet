import { executeGit } from "./git-execution.ts"
import { createHash } from "node:crypto"
import { lstat, open, readlink, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import type { GitBranchesSnapshot, GitDiffRequest, GitFileChange, GitFileDiff, GitFileStatus, GitRepositoryStatus, GitStatusSnapshot } from "./git-protocol.ts"
import { GitWatch } from "./git-watch.ts"

const STATUS_BYTES = 2 * 1024 * 1024
const PATCH_BYTES = 1024 * 1024
const COUNT_BYTES = 128 * 1024
const MAX_FILES = 10_000
const MAX_UNTRACKED_COUNTS = 512
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
type CommandError = Error & { code?: string | number; stdout?: string; stderr?: string; gitCommandOutput?: boolean }

// Accidental git init in $HOME or / turns both machine-scoped Sessions and any
// non-Git child directory into a full-disk status scan and FSEvents storm.
// Refuse those toplevel roots while keeping real child repositories inside $HOME usable.
async function isProtectedRoot(root: string): Promise<boolean> {
  if (dirname(root) === root) return true
  const home = await realpath(homedir()).catch(() => resolve(homedir()))
  return root === home
}

async function git(root: string, args: string[], limit = STATUS_BYTES, allowTruncation = false): Promise<{ text: string; truncated: boolean }> {
  try {
    const result = await executeGit(["-C", root, ...args], {
      optionalLocks: false, literalPaths: true, maxBuffer: limit, timeout: 15_000,
    })
    return { text: result.stdout, truncated: false }
  } catch (reason) {
    const error = reason as CommandError
    if (allowTruncation && error.gitCommandOutput && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && error.stdout) {
      return { text: error.stdout, truncated: true }
    }
    throw new Error(error.stderr?.trim() || message(reason))
  }
}

const repositoryId = (root: string) => createHash("sha256").update(root).digest("hex")
const within = (root: string, path: string) => { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) }
const conflicts = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"])
const statuses: Record<string, GitFileStatus> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "typeChanged", U: "conflicted" }

function parseStatus(text: string, truncated = false): GitFileChange[] {
  const fields = text.split("\0")
  if (truncated) fields.pop()
  const changes: GitFileChange[] = []
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!
    if (!field) continue
    const xy = field.slice(0, 2)
    const path = field.slice(3)
    const previousPath = /[RC]/u.test(xy) ? fields[++index] : undefined
    if (/[RC]/u.test(xy) && previousPath === undefined) break
    const base = { path, additions: null, deletions: null }
    if (xy === "??") { changes.push({ ...base, kind: "untracked", status: "untracked" }); continue }
    if (conflicts.has(xy)) { changes.push({ ...base, kind: "unstaged", status: "conflicted" }); continue }
    for (const [position, kind] of [[0, "staged"], [1, "unstaged"]] as const) {
      const code = xy[position]!
      if (code === " " || code === "!") continue
      changes.push({ ...base, kind, status: statuses[code] ?? "modified", ...(/[RC]/u.test(code) && previousPath ? { previousPath } : {}) })
    }
  }
  return changes
}

async function changes(root: string, path?: string): Promise<{ files: GitFileChange[]; truncated: boolean }> {
  const output = await git(root, ["status", "--porcelain=v1", "-z", "--find-renames", "--untracked-files=all", "--ignore-submodules=none", ...(path ? ["--", path] : [])], STATUS_BYTES, true)
  return { files: parseStatus(output.text, output.truncated), truncated: output.truncated }
}

function parseCounts(text: string, truncated = false): Map<string, { additions: number | null; deletions: number | null }> {
  const fields = text.split("\0")
  if (truncated) fields.pop()
  const counts = new Map<string, { additions: number | null; deletions: number | null }>()
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!
    if (!field) continue
    const first = field.indexOf("\t")
    const second = field.indexOf("\t", first + 1)
    if (first < 0 || second < 0) continue
    let path = field.slice(second + 1)
    if (!path) { index++; path = fields[++index]!; if (path === undefined) break }
    const added = field.slice(0, first)
    const deleted = field.slice(first + 1, second)
    counts.set(path, { additions: added === "-" ? null : Number(added), deletions: deleted === "-" ? null : Number(deleted) })
  }
  return counts
}

const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--ignore-submodules=none"]

/** Read files as Git entries: a symlink's contents are its target name, never its target file. */
async function untrackedContent(root: string, path: string, limit: number): Promise<{ data: Buffer; truncated: boolean; mode: string }> {
  const absolute = resolve(root, path)
  if (!within(root, absolute) || !within(root, await realpath(dirname(absolute)))) throw new Error("File is outside this Session checkout")
  const entry = await lstat(absolute)
  if (entry.isSymbolicLink()) return { data: Buffer.from(await readlink(absolute)), truncated: false, mode: "120000" }
  if (!entry.isFile()) throw new Error("This Git entry is not a regular file")
  const file = await open(absolute, "r")
  try {
    const data = Buffer.alloc(limit + 1)
    const { bytesRead } = await file.read(data, 0, data.byteLength, 0)
    return { data: data.subarray(0, Math.min(bytesRead, limit)), truncated: bytesRead > limit, mode: entry.mode & 0o111 ? "100755" : "100644" }
  } finally { await file.close() }
}

const binary = (data: Buffer) => data.subarray(0, 8000).includes(0)
const lineCount = (data: Buffer) => {
  let lines = 0
  for (const byte of data) if (byte === 10) lines++
  return lines + (data.length && data.at(-1) !== 10 ? 1 : 0)
}

async function inspect(root: string): Promise<GitRepositoryStatus> {
  const result: GitRepositoryStatus = { id: repositoryId(root), root, branch: null, head: null, changes: [] }
  try {
    const [files, branch, head, staged, unstaged] = await Promise.all([
      changes(root),
      git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then(value => value.text.replace(/\n$/u, "")).catch(() => null),
      git(root, ["rev-parse", "--verify", "HEAD"]).then(value => value.text.trim()).catch(() => null),
      git(root, ["diff", ...diffOptions, "--cached", "--numstat", "-z", "--"], STATUS_BYTES, true),
      git(root, ["diff", ...diffOptions, "--numstat", "-z", "--"], STATUS_BYTES, true),
    ])
    result.branch = branch
    result.head = head
    result.changes = files.files.slice(0, MAX_FILES)
    if (files.truncated || files.files.length > MAX_FILES) result.error = `Showing the first ${result.changes.length} changed entries; this checkout has too many changes to display at once`
    else if (staged.truncated || unstaged.truncated) result.error = "Some change counts are unavailable because this checkout has too many changes"
    const counts = { staged: parseCounts(staged.text, staged.truncated), unstaged: parseCounts(unstaged.text, unstaged.truncated) }
    let untrackedCounts = 0
    for (const change of result.changes) {
      if (change.kind !== "untracked") {
        if (change.status !== "conflicted") Object.assign(change, counts[change.kind].get(change.path))
        continue
      }
      // Cap sequential file reads for line counts when a checkout has thousands
      // of untracked files; remaining entries still appear with null line counts.
      if (untrackedCounts >= MAX_UNTRACKED_COUNTS) continue
      untrackedCounts++
      try {
        const content = await untrackedContent(root, change.path, COUNT_BYTES)
        if (!content.truncated && !binary(content.data)) { change.additions = lineCount(content.data); change.deletions = 0 }
      } catch { /* A file may disappear during a live scan; the next snapshot reconciles it. */ }
    }
  } catch (error) { result.error = message(error) }
  return result
}

async function resolveDirectories(paths: string[]): Promise<{ directories: GitStatusSnapshot["directories"]; roots: Map<string, string> }> {
  const directories: GitStatusSnapshot["directories"] = []
  const roots = new Map<string, string>()
  for (const path of paths) {
    try {
      if (!(await stat(path)).isDirectory()) throw new Error("Session path is not a directory")
      const output = (await git(path, ["rev-parse", "--show-toplevel"])).text.replace(/\n$/u, "")
      const root = await realpath(output)
      if (await isProtectedRoot(root)) {
        directories.push({ path, repositoryId: null, error: "Refusing to inspect the home or root directory as a Git repository" })
        continue
      }
      const id = repositoryId(root)
      roots.set(id, root)
      directories.push({ path, repositoryId: id })
    } catch (error) {
      const detail = message(error)
      const notGit = /not a git repository|must be run in a work tree/u.test(detail)
      directories.push({ path, repositoryId: null, ...(!notGit ? { error: detail } : {}) })
    }
  }
  return { directories, roots }
}

function newFilePatch(path: string, content: { data: Buffer; truncated: boolean; mode: string }): { patch: string; binary: boolean; truncated: boolean } {
  const oldName = JSON.stringify(`a/${path}`)
  const newName = JSON.stringify(`b/${path}`)
  let patch = `diff --git ${oldName} ${newName}\nnew file mode ${content.mode}\n`
  if (binary(content.data)) return { patch: `${patch}Binary files /dev/null and ${newName} differ\n`, binary: true, truncated: false }
  if (content.data.length) {
    const lines = content.data.toString("utf8").split("\n")
    const newline = lines.at(-1) === ""
    if (newline) lines.pop()
    patch += `--- /dev/null\n+++ ${newName}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join("\n")}\n`
    if (!newline && !content.truncated) patch += "\\ No newline at end of file\n"
  }
  const bytes = Buffer.from(patch)
  return { patch: bytes.subarray(0, PATCH_BYTES).toString("utf8"), binary: false, truncated: content.truncated || bytes.length > PATCH_BYTES }
}

interface WatchedCheckout {
  watcher: GitWatch
  ready: Promise<void>
  listeners: Set<(error?: string) => void>
  version: number
  cached?: GitRepositoryStatus
  pending?: { version: number; result: Promise<GitRepositoryStatus> }
}

/** A watched checkout shares its transient status until an OS notification invalidates it. */
export class GitInspection {
  readonly #watched = new Map<string, WatchedCheckout>()
  readonly #maxWatchedDirectories: number | undefined
  #closed = false

  constructor(maxWatchedDirectories?: number) {
    this.#maxWatchedDirectories = maxWatchedDirectories
  }

  async watch(paths: string[], listener: (error?: string) => void): Promise<() => void> {
    if (this.#closed) throw new Error("Git inspection is stopping")
    const { directories, roots } = await resolveDirectories(paths)
    const watchedRoots = new Set(roots.values())
    const unavailable: string[] = []
    for (const directory of directories) {
      if (directory.error) unavailable.push(`${directory.path}: ${directory.error}`)
      else if (directory.repositoryId === null) {
        try {
          const physical = await realpath(directory.path)
          if (!await isProtectedRoot(physical)) watchedRoots.add(physical)
        } catch (error) { unavailable.push(`${directory.path}: ${message(error)}`) }
      }
    }
    const directoryError = unavailable.length ? `Could not watch Git changes in ${unavailable.join("; ")}` : undefined
    const attached: WatchedCheckout[] = []
    const subscriber = (error?: string) => listener(attached.find(entry => entry.watcher.error)?.watcher.error ?? error ?? directoryError)
    const release = () => {
      for (const entry of attached) {
        entry.listeners.delete(subscriber)
        if (!entry.listeners.size) {
          entry.watcher.close()
          if (this.#watched.get(entry.watcher.root) === entry) this.#watched.delete(entry.watcher.root)
        }
      }
    }
    try {
      for (const root of watchedRoots) {
        if (this.#closed) throw new Error("Git inspection is stopping")
        let entry = this.#watched.get(root)
        const existing = !!entry
        if (!entry) {
          const watcher = new GitWatch(root, error => {
            entry!.version++
            entry!.cached = undefined
            for (const changed of entry!.listeners) changed(error)
          }, this.#maxWatchedDirectories)
          entry = { watcher, ready: Promise.resolve(), listeners: new Set([subscriber]), version: 0 }
          this.#watched.set(root, entry)
          entry.ready = watcher.start()
        }
        entry.listeners.add(subscriber)
        attached.push(entry)
        await entry.ready
        if (existing && !entry.watcher.healthy) {
          entry.ready = entry.watcher.start()
          await entry.ready
        }
      }
      if (this.#closed) throw new Error("Git inspection is stopping")
      // A missing binding must remain visible without disabling healthy checkouts.
      // Reattaching (including manual refresh) retries unavailable directories.
      if (directoryError) subscriber()
      return release
    } catch (error) { release(); throw error }
  }

  close(): void {
    this.#closed = true
    for (const entry of this.#watched.values()) entry.watcher.close()
    this.#watched.clear()
  }

  async #status(root: string, force: boolean): Promise<GitRepositoryStatus> {
    const entry = this.#watched.get(root)
    if (!entry || !entry.watcher.healthy) return inspect(root)
    if (force) { entry.version++; entry.cached = undefined }
    if (entry.cached) return entry.cached
    if (entry.pending) {
      if (entry.pending.version === entry.version) return entry.pending.result
      await entry.pending.result
      return this.#status(root, false)
    }
    const version = entry.version
    const result = inspect(root).then(snapshot => {
      if (entry.version === version && entry.watcher.healthy && this.#watched.get(root) === entry && !snapshot.error) entry.cached = snapshot
      return snapshot
    })
    entry.pending = { version, result }
    try { return await result } finally { if (entry.pending?.result === result) entry.pending = undefined }
  }

  async status(sessionId: string, paths: string[], force = false): Promise<GitStatusSnapshot> {
    const { directories, roots } = await resolveDirectories(paths)
    const repositories: GitRepositoryStatus[] = []
    for (const root of roots.values()) repositories.push(await this.#status(root, force))
    return { sessionId, repositories, directories }
  }

  async branches(workspaceId: string, path: string): Promise<GitBranchesSnapshot> {
    try {
      if (!(await stat(path)).isDirectory()) return { workspaceId, currentBranch: null, branches: [] }
      const output = (await git(path, ["rev-parse", "--show-toplevel"])).text.replace(/\n$/u, "")
      const root = await realpath(output)
      if (await isProtectedRoot(root)) return { workspaceId, currentBranch: null, branches: [] }
      const [symbolic, refs] = await Promise.all([
        git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then(value => value.text.replace(/\n$/u, "")).catch(() => null),
        git(root, ["for-each-ref", "--format=%(refname)%00%(symref)", "refs/heads", "refs/remotes"]),
      ])
      const localBranches: string[] = []
      const remoteBranches: string[] = []
      const seen = new Set<string>()
      for (const line of refs.text.split("\n")) {
        if (!line) continue
        const [ref = "", symref = ""] = line.split("\0")
        if (ref.startsWith("refs/heads/")) {
          const name = ref.slice("refs/heads/".length).trim()
          if (name && !seen.has(name)) { seen.add(name); localBranches.push(name) }
        } else if (ref.startsWith("refs/remotes/")) {
          if (symref.trim() || ref.endsWith("/HEAD")) continue
          const name = ref.slice("refs/remotes/".length).trim()
          if (name && name !== "HEAD" && !seen.has(name)) { seen.add(name); remoteBranches.push(name) }
        }
      }
      const currentBranch = symbolic && localBranches.includes(symbolic) ? symbolic : null
      const branches = [
        ...(currentBranch ? [currentBranch, ...localBranches.filter(name => name !== currentBranch)] : localBranches),
        ...remoteBranches,
      ]
      return { workspaceId, currentBranch, branches }
    } catch {
      return { workspaceId, currentBranch: null, branches: [] }
    }
  }

  async diff(request: GitDiffRequest, paths: string[]): Promise<GitFileDiff> {
    const { roots } = await resolveDirectories(paths)
    const root = roots.get(request.repositoryId)
    if (!root) throw new Error("Repository does not belong to this Session")
    if (request.path.includes("\0") || isAbsolute(request.path) || !within(root, resolve(root, request.path))) throw new Error("Invalid Git file path")
    const status = await changes(root)
    let change = status.files.find(file => file.path === request.path && file.kind === request.kind)
    if (!change && status.truncated) change = (await changes(root, request.path)).files.find(file => file.path === request.path && file.kind === request.kind)
    if (!change) throw new Error("This file change is no longer present; refresh the changes list")
    if (request.kind === "untracked") return { ...request, ...newFilePatch(request.path, await untrackedContent(root, request.path, PATCH_BYTES)) }
    const args = ["diff", ...diffOptions, "--unified=3", "--src-prefix=a/", "--dst-prefix=b/"]
    if (request.kind === "staged") args.push("--cached")
    args.push("--", request.path, ...(change.previousPath ? [change.previousPath] : []))
    const output = await git(root, args, PATCH_BYTES, true)
    return { ...request, patch: output.text, binary: /^Binary files .* differ$/mu.test(output.text), truncated: output.truncated }
  }
}
