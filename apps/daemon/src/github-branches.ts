import { execFile } from "node:child_process"
import { watch, type FSWatcher } from "node:fs"
import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"
import type { CatalogSnapshot, GitHubBranch, SessionGitHubBranches } from "./catalog-protocol.ts"

const execute = promisify(execFile)

async function git(root: string, args: string[]): Promise<string> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete (env as NodeJS.ProcessEnv)[name]
  return (await execute("git", ["-C", root, ...args], { env, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 15_000, windowsHide: true })).stdout.replace(/\r?\n$/u, "")
}

/** Parse public GitHub remote syntax without retaining embedded credentials. */
export function githubRepository(remote: string): string | undefined {
  const scp = /^(?:[^@/:]+@)?github\.com:([^?#]+)$/iu.exec(remote)
  let path = scp?.[1]
  if (!path) {
    try {
      const url = new URL(remote)
      if (url.hostname.toLowerCase() !== "github.com" || !["https:", "ssh:", "git:"].includes(url.protocol) || url.port || url.search || url.hash) return
      path = url.pathname.replace(/^\//u, "")
    } catch { return }
  }
  const repository = path.replace(/\.git\/?$/iu, "").replace(/\/$/u, "")
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u.test(repository) || repository.endsWith("/.") || repository.endsWith("/..")) return
  return repository.toLowerCase()
}

async function branches(root: string): Promise<GitHubBranch[]> {
  const reference = await git(root, ["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")
  if (!reference.startsWith("refs/heads/")) return []
  const branch = reference.slice("refs/heads/".length)
  const config = new Map<string, string>()
  for (const entry of (await git(root, ["config", "--null", "--list"])).split("\0")) {
    const end = entry.indexOf("\n")
    if (end >= 0) config.set(entry.slice(0, end), entry.slice(end + 1))
  }
  const remotes = new Map<string, string>()
  const pushRepositories = new Map<string, string>()
  for (const [key, value] of config) {
    const match = /^remote\.(.+)\.(url|pushurl)$/u.exec(key)
    const remote = match?.[1]
    const repository = remote && githubRepository(value)
    if (remote && repository) (match?.[2] === "pushurl" ? pushRepositories : remotes).set(remote, repository)
  }
  const upstream = config.get(`branch.${branch}.remote`)
  const pushRemote = config.get(`branch.${branch}.pushremote`) ?? config.get("remote.pushdefault")
  const headRemote = pushRemote ?? (upstream && remotes.has(upstream) ? upstream : undefined)
    ?? (remotes.has("origin") ? "origin" : remotes.keys().next().value)
  const headRepository = headRemote && (pushRepositories.get(headRemote) ?? remotes.get(headRemote))
  if (!headRepository) return []
  const merge = config.get(`branch.${branch}.merge`)
  const pushesCurrentName = ["current", "matching"].includes(config.get("push.default") ?? "")
  const headBranch = !pushesCurrentName && headRemote === upstream && merge?.startsWith("refs/heads/") ? merge.slice("refs/heads/".length) : branch
  return [...new Set(remotes.values())].sort().map(repository => ({ repository, headRepository, branch: headBranch }))
}

interface Checkout {
  root: string
  watchers: Map<string, FSWatcher>
  repositories: GitHubBranch[]
  pending?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  again: boolean
  closed: boolean
}

/** Observe branch identity only; working files, indexes and refs do not need scans. */
export class GitHubBranches {
  readonly #checkouts = new Map<string, Checkout>()
  readonly #changed: () => void
  #closed = false

  constructor(changed: () => void) { this.#changed = changed }

  async snapshot(catalog: CatalogSnapshot, inactive = new Set<string>()): Promise<SessionGitHubBranches[]> {
    const worktrees = [...catalog.sessions, ...catalog.workspaces.flatMap(workspace => workspace.worktrees)]
      .filter(worktree => worktree.sessionId && !inactive.has(worktree.sessionId))
    const used = new Set<string>()
    const resolved = new Map<string, Promise<Checkout | undefined>>()
    const entries: SessionGitHubBranches[] = []
    for (const worktree of worktrees) {
      const repositories = new Map<string, GitHubBranch>()
      for (const directory of worktree.directories) {
        let pending = resolved.get(directory.path)
        if (!pending) {
          pending = this.#checkout(directory.path)
          resolved.set(directory.path, pending)
        }
        const checkout = await pending
        if (!checkout) continue
        used.add(checkout.root)
        await checkout.pending
        for (const repository of checkout.repositories) repositories.set(JSON.stringify(repository), repository)
      }
      if (repositories.size) entries.push({ sessionId: worktree.sessionId!, repositories: [...repositories.values()] })
    }
    for (const [root, checkout] of this.#checkouts) if (!used.has(root)) {
      this.#release(checkout)
      this.#checkouts.delete(root)
    }
    return entries
  }

  async #checkout(path: string): Promise<Checkout | undefined> {
    if (this.#closed) return
    let root: string
    try {
      const directory = await realpath(path)
      root = await git(directory, ["rev-parse", "--show-toplevel"]).then(value => realpath(value)).catch(() => directory)
    } catch { return }
    if (this.#closed) return
    const existing = this.#checkouts.get(root)
    if (existing) return existing
    const checkout: Checkout = { root, watchers: new Map(), repositories: [], again: false, closed: false }
    this.#checkouts.set(root, checkout)
    await this.#refresh(checkout, false)
    return checkout
  }

  #schedule(checkout: Checkout): void {
    if (checkout.closed || this.#closed) return
    if (checkout.pending) { checkout.again = true; return }
    clearTimeout(checkout.timer)
    checkout.timer = setTimeout(() => { checkout.timer = undefined; void this.#refresh(checkout, true) }, 100)
    checkout.timer.unref()
  }

  #refresh(checkout: Checkout, notify: boolean): Promise<void> {
    if (checkout.pending) return checkout.pending
    checkout.pending = (async () => {
      do {
        checkout.again = false
        const directories = new Set([checkout.root])
        try {
          const paths = await git(checkout.root, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])
          for (const path of paths.split("\n")) directories.add(resolve(checkout.root, path))
        } catch { /* A directory Session can acquire a repository later. */ }
        if (checkout.closed || this.#closed) return
        for (const [path, watcher] of checkout.watchers) if (!directories.has(path)) {
          watcher.close(); checkout.watchers.delete(path)
        }
        for (const path of directories) if (!checkout.watchers.has(path)) {
          try {
            const watcher = watch(path, (_event, filename) => {
              const name = filename?.toString()
              if (!name || (path === checkout.root ? name === ".git" : ["HEAD", "config", "config.worktree", "commondir"].includes(name))) this.#schedule(checkout)
            })
            watcher.on("error", () => {
              watcher.close(); checkout.watchers.delete(path)
              this.#schedule(checkout)
            })
            checkout.watchers.set(path, watcher)
          } catch { /* Missing checkout metadata is represented by no locator. */ }
        }
        const next = await branches(checkout.root).catch(() => [])
        if (checkout.closed || this.#closed) return
        if (JSON.stringify(next) !== JSON.stringify(checkout.repositories)) {
          checkout.repositories = next
          if (notify) this.#changed()
        }
      } while (checkout.again && !checkout.closed && !this.#closed)
    })().finally(() => { checkout.pending = undefined })
    return checkout.pending
  }

  #release(checkout: Checkout): void {
    checkout.closed = true
    clearTimeout(checkout.timer)
    for (const watcher of checkout.watchers.values()) watcher.close()
    checkout.watchers.clear()
  }

  close(): void {
    this.#closed = true
    for (const checkout of this.#checkouts.values()) this.#release(checkout)
    this.#checkouts.clear()
  }
}
