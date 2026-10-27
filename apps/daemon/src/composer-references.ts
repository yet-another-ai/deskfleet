import { execFile } from "node:child_process"
import { opendir, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import type { ContentBlock } from "@agentclientprotocol/sdk/unstable"
import type { AgentSessionRecord } from "./agent-protocol.ts"
import type { CatalogSnapshot, CatalogWorktree } from "./catalog-protocol.ts"
import type {
  ComposerFileReference, ComposerReference, ComposerReferenceCandidate, ComposerReferenceResolve,
  ComposerReferenceResult, ComposerReferenceScope, ComposerReferenceSearch,
} from "./composer-reference-protocol.ts"

interface ReferenceCatalog {
  native: { snapshot(): Promise<Pick<CatalogSnapshot, "workspaces">> }
  sessionWorktree(sessionId: string): Promise<Pick<CatalogWorktree, "directories"> | undefined>
}
interface ReferenceJournal {
  identity: { originId: string }
  list(): Promise<AgentSessionRecord[]>
  read(sessionId: string): Promise<{ session: AgentSessionRecord }>
}
interface ReferenceContext { workspaceId?: string; sessionId?: string; directories: string[] }
interface SearchBudget { entries: number; directories: number; deadline: number; truncated: boolean }
const MAX_ENTRIES = 10_000
const MAX_DIRECTORIES = 512
const MAX_RESULTS = 50
const SEARCH_TIME_MS = 3_000
const key = (path: string) => path.split(sep).join("/")
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
const within = (root: string, path: string) => { const value = relative(root, path); return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value) }

function resourceId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/u.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new Error("Invalid reference resource ID")
  }
}
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid composer reference request")
}
function validateScope(value: ComposerReferenceScope): void {
  if (value.sessionId !== undefined) resourceId(value.sessionId)
  if (value.workspaceId !== undefined) resourceId(value.workspaceId)
}
function filePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > 4096 || value.includes("\0") || value.includes("\\")
    || isAbsolute(value) || value.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new Error("Invalid file reference path")
  }
}
function validateReference(value: unknown): asserts value is ComposerReference {
  object(value)
  if (typeof value.originId !== "string" || !value.originId) throw new Error("Invalid reference origin")
  resourceId(value.workspaceId)
  if (value.kind === "session") { resourceId(value.sessionId); return }
  if (value.kind !== "file") throw new Error("Invalid composer reference kind")
  if (value.sessionId !== undefined) resourceId(value.sessionId)
  if (!Number.isSafeInteger(value.directoryIndex) || Number(value.directoryIndex) < 0) throw new Error("Invalid file reference directory")
  if (typeof value.sourceDirectory !== "string" || !isAbsolute(value.sourceDirectory) || value.sourceDirectory.includes("\0")) {
    throw new Error("Invalid file reference source directory")
  }
  filePath(value.relativePath)
}

function git(root: string, args: string[], input?: string): Promise<string> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "0", LC_ALL: "C" }
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete (env as NodeJS.ProcessEnv)[name]
  return new Promise((accept, reject) => {
    const child = execFile("git", ["-C", root, ...args], { env, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: SEARCH_TIME_MS, windowsHide: true }, (error, stdout, stderr) => {
      if (error && !(args[0] === "check-ignore" && error.code === 1)) reject(new Error(stderr.trim() || error.message))
      else accept(stdout)
    })
    child.stdin?.on("error", () => {})
    child.stdin?.end(input)
  })
}
async function repository(root: string): Promise<string | undefined> {
  try { return (await git(root, ["rev-parse", "--show-toplevel"])).trimEnd() }
  catch (error) {
    if (error instanceof Error && error.message.includes("not a git repository")) return undefined
    throw error
  }
}
async function ignored(root: string | undefined, paths: string[]): Promise<Set<string>> {
  if (!root || !paths.length) return new Set()
  const input = paths.map(path => "./" + key(relative(root, path))).join("\0") + "\0"
  return new Set((await git(root, ["check-ignore", "--no-index", "-z", "--stdin"], input)).split("\0").filter(Boolean).map(path => resolve(root, path)))
}

/** Searches stay on the owning daemon and have no persistent index or watchers. */
export class ComposerReferences {
  readonly #catalog: ReferenceCatalog
  readonly #journal: ReferenceJournal

  constructor(catalog: ReferenceCatalog, journal: ReferenceJournal) {
    this.#catalog = catalog
    this.#journal = journal
  }

  async #workspaceDirectories(workspaceId: string): Promise<string[]> {
    const workspace = (await this.#catalog.native.snapshot()).workspaces.find(value => value.id === workspaceId)
    if (!workspace) throw new Error("Reference Workspace was not found")
    const directories = workspace.worktrees.find(worktree => !worktree.sessionId)?.directories.map(directory => directory.path)
    if (!directories?.length) throw new Error("Workspace directories are unavailable")
    return directories
  }

  async #context(scope: ComposerReferenceScope): Promise<ReferenceContext> {
    validateScope(scope)
    if (scope.sessionId) {
      const { session } = await this.#journal.read(scope.sessionId)
      if (scope.workspaceId !== undefined && scope.workspaceId !== session.workspaceId) throw new Error("Session is outside the reference Workspace")
      // A machine-scoped Session uses home for execution, not for implicit search.
      if (!session.workspaceId) return { sessionId: session.id, directories: [] }
      if (session.lifecycle !== "ready") throw new Error("This Session has no usable reference context")
      const worktree = await this.#catalog.sessionWorktree(session.id)
      if (!worktree?.directories.length) throw new Error("Session directories are unavailable")
      return { sessionId: session.id, workspaceId: session.workspaceId, directories: worktree.directories.map(directory => directory.path) }
    }
    if (!scope.workspaceId) return { directories: [] }
    return { workspaceId: scope.workspaceId, directories: await this.#workspaceDirectories(scope.workspaceId) }
  }

  async search(value: unknown, allowSessionReferences = true): Promise<ComposerReferenceResult> {
    object(value)
    const params = value as unknown as ComposerReferenceSearch
    if (params.kind !== "file" && params.kind !== "session") throw new Error("Invalid composer reference kind")
    if (typeof params.query !== "string" || params.query.length > 256 || params.query.includes("\0")) throw new Error("Invalid reference search query")
    if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > MAX_RESULTS)) throw new Error("Invalid reference search limit")
    const limit = params.limit ?? 20
    const context = await this.#context(params)
    if (!context.workspaceId || params.kind === "session" && !allowSessionReferences) return { items: [], truncated: false }
    const query = params.query.trim().toLocaleLowerCase()
    if (params.kind === "session") {
      const matches = (await this.#journal.list())
        .filter(session => session.workspaceId === context.workspaceId && session.id !== context.sessionId && session.lifecycle !== "deleting"
          && `${session.title}\n${session.id}\n${session.provider}`.toLocaleLowerCase().includes(query))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      return { items: matches.slice(0, limit).map(session => ({
        reference: { kind: "session", originId: this.#journal.identity.originId, workspaceId: context.workspaceId!, sessionId: session.id },
        name: session.title || `Session ${session.id}`, description: `${session.provider} · ${session.id}`,
        updatedAt: session.updatedAt, archived: session.archiveState === "archived",
      })), truncated: matches.length > limit }
    }
    const items: ComposerReferenceCandidate[] = []
    const budget: SearchBudget = { entries: 0, directories: 0, deadline: Date.now() + SEARCH_TIME_MS, truncated: false }
    for (const [directoryIndex, sourceDirectory] of context.directories.entries()) {
      await this.#files(context, directoryIndex, sourceDirectory, query, limit, items, budget)
      if (items.length > limit || budget.truncated) break
    }
    return { items: items.slice(0, limit), truncated: items.length > limit || budget.truncated }
  }

  async #files(context: ReferenceContext, directoryIndex: number, sourceDirectory: string, query: string, limit: number, items: ComposerReferenceCandidate[], budget: SearchBudget): Promise<void> {
    const root = await realpath(sourceDirectory)
    const queue = [{ path: root, repository: await repository(root) }]
    while (queue.length) {
      if (budget.entries >= MAX_ENTRIES || budget.directories >= MAX_DIRECTORIES || Date.now() >= budget.deadline) { budget.truncated = true; return }
      const current = queue.shift()!
      budget.directories++
      const entries: { path: string; directory: boolean }[] = []
      let hasMetadata = false
      try {
        for await (const entry of await opendir(current.path)) {
          budget.entries++
          if (entry.name.toLowerCase() === ".git") { hasMetadata = true; continue }
          if (entry.isFile() || entry.isDirectory()) entries.push({ path: join(current.path, entry.name), directory: entry.isDirectory() })
          if (budget.entries >= MAX_ENTRIES) { budget.truncated = true; break }
        }
      } catch (error) { if (missing(error) && current.path !== root) continue; throw error }
      if (hasMetadata) current.repository = await repository(current.path)
      entries.sort((left, right) => left.path.localeCompare(right.path))
      const excluded = await ignored(current.repository, entries.map(entry => entry.path))
      for (const entry of entries) {
        if (excluded.has(entry.path)) continue
        if (entry.directory) { queue.push({ path: entry.path, repository: current.repository }); continue }
        const relativePath = key(relative(root, entry.path))
        if (relativePath.includes("\\")) continue
        if (!relativePath.toLocaleLowerCase().includes(query)) continue
        items.push({
          reference: { kind: "file", originId: this.#journal.identity.originId, workspaceId: context.workspaceId!,
            ...(context.sessionId ? { sessionId: context.sessionId } : {}), directoryIndex, sourceDirectory, relativePath },
          name: relativePath, description: sourceDirectory,
        })
        if (items.length > limit) return
      }
      if (budget.truncated) return
    }
  }

  async resolve(value: unknown): Promise<ContentBlock[]> {
    object(value)
    const params = value as unknown as ComposerReferenceResolve
    resourceId(params.sessionId)
    if (!Array.isArray(params.references) || params.references.length > 50) throw new Error("Invalid composer references")
    const context = await this.#context({ sessionId: params.sessionId })
    const blocks: ContentBlock[] = []
    for (const reference of params.references) {
      validateReference(reference)
      if (reference.originId !== this.#journal.identity.originId) throw new Error("Reference belongs to another machine catalog")
      if (!context.workspaceId || reference.workspaceId !== context.workspaceId) throw new Error("Reference is outside this Session's Workspace")
      if (reference.kind === "file") {
        blocks.push(await this.#file(reference, context))
      } else {
        const { session } = await this.#journal.read(reference.sessionId)
        if (session.workspaceId !== context.workspaceId || session.lifecycle === "deleting") throw new Error("Referenced Session is outside this Workspace or unavailable")
        blocks.push({ type: "text", text: `Referenced deskfleet Session: ${JSON.stringify({ ...reference, title: session.title })}.\nFirst inspect its current snapshot with deskfleet_session({"sessionId":${JSON.stringify(session.id)}}). From the returned session.lastEventSeq, compute afterSeq as the decimal string for max(0, BigInt(session.lastEventSeq) - 100n). Call deskfleet_session_history with sessionId ${JSON.stringify(session.id)}, that afterSeq, and limit 100 to read its latest recorded context. Request earlier pages only if more context is needed.` })
      }
    }
    return blocks
  }

  async #file(reference: ComposerFileReference, context: ReferenceContext): Promise<ContentBlock> {
    if (reference.sessionId && reference.sessionId !== context.sessionId) throw new Error("File reference belongs to another Session")
    const sources = reference.sessionId ? context.directories : await this.#workspaceDirectories(context.workspaceId!)
    if (sources[reference.directoryIndex] !== reference.sourceDirectory) throw new Error("The file reference's source directory has changed; select the file again")
    const directory = context.directories[reference.directoryIndex]
    if (!directory) throw new Error("Referenced directory is unavailable in this Session")
    const root = await realpath(directory)
    const path = resolve(root, reference.relativePath)
    let actual: string
    try { actual = await realpath(path) }
    catch (error) {
      if (missing(error)) throw new Error(`Referenced file is unavailable in this Session: ${reference.relativePath}. Select a file from this Session's directories.`, { cause: error })
      throw error
    }
    if (!within(root, actual)) throw new Error("Referenced file is outside the Session directory")
    const info = await stat(actual)
    if (!info.isFile()) throw new Error("Reference must name a regular file")
    if ((await ignored(await repository(dirname(path)), [path])).has(path)) throw new Error("Referenced file is Git-ignored")
    return { type: "resource_link", uri: pathToFileURL(path).href, name: reference.relativePath, size: info.size }
  }
}
