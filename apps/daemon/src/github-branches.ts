import { executeGit } from "./git-execution.ts"
import { watch, type FSWatcher } from "node:fs"
import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import type { CatalogDirectory, CatalogSnapshot, GitHubBranch, SessionGitHubBranches } from "./catalog-protocol.ts"


async function git(root: string, args: string[]): Promise<string> {
  return (await executeGit(["-C", root, ...args], { optionalLocks: false, maxBuffer: 1024 * 1024, timeout: 15_000 })).stdout.replace(/\r?\n$/u, "")
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

interface CheckoutMetadata {
  repositories: string[]
  branches: GitHubBranch[]
}

async function readMetadata(root: string): Promise<CheckoutMetadata> {
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
  const repositories = [...new Set([...remotes.values(), ...pushRepositories.values()])].sort()
  const reference = await git(root, ["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")
  if (!reference.startsWith("refs/heads/")) return { repositories, branches: [] }
  const branch = reference.slice("refs/heads/".length)
  const upstream = config.get(`branch.${branch}.remote`)
  const pushRemote = config.get(`branch.${branch}.pushremote`) ?? config.get("remote.pushdefault")
  const headRemote = pushRemote ?? (upstream && remotes.has(upstream) ? upstream : undefined)
    ?? (remotes.has("origin") ? "origin" : remotes.keys().next().value)
  const headRepository = headRemote && (pushRepositories.get(headRemote) ?? remotes.get(headRemote))
  if (!headRepository) return { repositories, branches: [] }
  const merge = config.get(`branch.${branch}.merge`)
  const pushesCurrentName = ["current", "matching"].includes(config.get("push.default") ?? "")
  const headBranch = !pushesCurrentName && headRemote === upstream && merge?.startsWith("refs/heads/") ? merge.slice("refs/heads/".length) : branch
  return { repositories, branches: [...new Set(remotes.values())].sort().map(repository => ({ repository, headRepository, branch: headBranch })) }
}

interface Checkout {
  root: string
  watchers: Map<string, FSWatcher>
  metadata: CheckoutMetadata
  pending?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  again: boolean
  closed: boolean
}

/** Observe GitHub remotes and branch identity without scanning working files. */
export class GitHubBranches {
  readonly #checkouts = new Map<string, Checkout>()
  readonly #changed: () => void
  #closed = false

  constructor(changed: () => void) { this.#changed = changed }

  async snapshot(catalog: Pick<CatalogSnapshot, "workspaces" | "sessions">, inactive = new Set<string>()) {
    const worktrees = [...catalog.sessions, ...catalog.workspaces.flatMap(workspace => workspace.worktrees)]
      .filter(worktree => worktree.sessionId && !inactive.has(worktree.sessionId))
    const used = new Set<string>()
    const resolved = new Map<string, Promise<Checkout | undefined>>()
    const metadataFor = async (directories: CatalogDirectory[]) => {
      const metadata: CheckoutMetadata[] = []
      for (const directory of directories) {
        let pending = resolved.get(directory.path)
        if (!pending) {
          pending = this.#checkout(directory.path)
          resolved.set(directory.path, pending)
        }
        const checkout = await pending
        if (!checkout) continue
        used.add(checkout.root)
        await checkout.pending
        metadata.push(checkout.metadata)
      }
      return metadata
    }
    const workspaceGithubRepositories: NonNullable<CatalogSnapshot["workspaceGithubRepositories"]> = []
    for (const workspace of catalog.workspaces) {
      const main = workspace.worktrees.find(worktree => !worktree.sessionId)
      if (!main) continue
      const metadata = await metadataFor(main.directories)
      const repositories = [...new Set(metadata.flatMap(entry => entry.repositories))]
      if (repositories.length) workspaceGithubRepositories.push({ workspaceId: workspace.id, repositories })
    }
    const githubBranches: SessionGitHubBranches[] = []
    for (const worktree of worktrees) {
      const repositories = new Map<string, GitHubBranch>()
      for (const checkout of await metadataFor(worktree.directories)) {
        for (const branch of checkout.branches) repositories.set(JSON.stringify(branch), branch)
      }
      if (repositories.size) githubBranches.push({ sessionId: worktree.sessionId!, repositories: [...repositories.values()] })
    }
    for (const [root, checkout] of this.#checkouts) if (!used.has(root)) {
      this.#release(checkout)
      this.#checkouts.delete(root)
    }
    return { githubBranches, workspaceGithubRepositories }
  }

  async #checkout(path: string): Promise<Checkout | undefined> {
    if (this.#closed) return
    let root: string
    try {
      const directory = await realpath(path)
      // A known checkout root already watches its Git metadata. Avoid running
      // rev-parse per Workspace on every catalog read.
      const watched = this.#checkouts.get(directory)
      if (watched?.watchers.has(directory) && watched.watchers.size > 1) return watched
      root = await git(directory, ["rev-parse", "--show-toplevel"]).then(value => realpath(value)).catch(() => directory)
    } catch { return }
    if (this.#closed) return
    const existing = this.#checkouts.get(root)
    if (existing) return existing
    const checkout: Checkout = { root, watchers: new Map(), metadata: { repositories: [], branches: [] }, again: false, closed: false }
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
        let gitCheckout = false
        try {
          const paths = await git(checkout.root, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])
          for (const path of paths.split("\n")) directories.add(resolve(checkout.root, path))
          gitCheckout = true
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
        const metadata = gitCheckout ? await readMetadata(checkout.root).catch(() => undefined) : undefined
        const next = metadata ?? { repositories: [], branches: [] }
        if (checkout.closed || this.#closed) return
        if (JSON.stringify(next) !== JSON.stringify(checkout.metadata)) {
          checkout.metadata = next
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
