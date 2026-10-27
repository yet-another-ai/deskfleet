import { execFile } from "node:child_process"
import { watch, type FSWatcher } from "node:fs"
import { lstat, readdir, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const detail = (error: unknown) => error instanceof Error ? error.message : String(error)
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
const key = (path: string) => path.split(sep).join("/")
// Windows briefly denies `.git/config` while another Git process holds it (common
// during submodule add). Treat that as retryable contention, not a sticky failure.
const CONFIG_LOCK_RETRIES = 40
const transientGitConfigLock = (error: unknown) => {
  const text = detail(error)
  return /unable to access .+config['"]?: Permission denied/iu.test(text)
}

function git(root: string, args: string[], input?: string): Promise<string> {
  // check-ignore does not support literal pathspec magic. Its stdin paths are
  // prefixed with ./ instead, which also handles filenames beginning with :.
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "0", LC_ALL: "C" }
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete (env as NodeJS.ProcessEnv)[name]
  return new Promise((accept, reject) => {
    const child = execFile("git", ["-C", root, ...args], { env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 15_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error && !(["check-ignore", "config"].includes(args[0]!) && error.code === 1)) reject(new Error(stderr.trim() || error.message))
      else accept(stdout)
    })
    // check-ignore accepts NUL-delimited paths, including names with newlines.
    child.stdin?.on("error", () => {})
    child.stdin?.end(input)
  })
}

interface DirectoryWatch { watcher: FSWatcher; metadata: boolean }

/** OS notifications invalidate Git snapshots; Git still decides which files changed. */
export class GitWatch {
  readonly root: string
  readonly #changed: (error?: string) => void
  readonly #directories = new Map<string, DirectoryWatch>()
  readonly #submodules = new Map<string, GitWatch>()
  #ignored = new Set<string>()
  #tracked = new Set<string>()
  #gitDirectories = new Set<string>()
  #externalIgnore: string | undefined
  #repository = false
  readonly #candidates = new Map<string, boolean>()
  #classifying = false
  #closed = false
  #timer: ReturnType<typeof setTimeout> | undefined
  #rebuilding: Promise<void> | undefined
  #again = false
  #started = false
  #error: string | undefined
  #configLockStreak = 0
  healthy = true

  constructor(root: string, changed: (error?: string) => void) {
    this.root = root
    this.#changed = changed
  }

  get error(): string | undefined { return this.#error }

  async start(): Promise<void> {
    await this.#rebuild()
  }

  close(): void {
    this.#closed = true
    clearTimeout(this.#timer)
    for (const { watcher } of this.#directories.values()) watcher.close()
    this.#directories.clear()
    for (const watcher of this.#submodules.values()) watcher.close()
    this.#submodules.clear()
    this.#candidates.clear()
  }

  #failure(error: unknown): void {
    if (this.#closed) return
    this.healthy = false
    this.#error = `Could not watch Git changes: ${detail(error)}`
    this.#notify()
  }

  #notify(): void { if (!this.#closed) this.#changed(this.#error) }

  #schedule(): void {
    if (this.#closed) return
    if (this.#rebuilding) { this.#again = true; return }
    clearTimeout(this.#timer)
    // Only topology/ignore changes rebuild directory subscriptions, not file writes.
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.#rebuild() }, 50)
    this.#timer.unref()
  }

  /** Retry a transient config lock without reporting a sticky watcher failure. */
  async #deferConfigLock(): Promise<boolean> {
    if (this.#closed) return false
    this.#configLockStreak++
    if (this.#configLockStreak > CONFIG_LOCK_RETRIES) {
      this.#configLockStreak = 0
      return false
    }
    const delayMs = Math.min(50 * this.#configLockStreak, 500)
    // Always wait: inside an active rebuild `#schedule` would only set `#again`
    // and a tight continue loop would spin on the still-locked config file.
    // Keep the timer referenced so `await start()` cannot finish while a retry
    // is owed (unref would let the event loop drain under test).
    await new Promise<void>(resolve => { setTimeout(resolve, delayMs) })
    return !this.#closed
  }

  #event(directory: string, metadata: boolean, event: string, filename: string | null): void {
    if (this.#closed) return
    const path = filename === null ? directory : resolve(directory, filename)
    if (directory === this.root && event === "rename" && filename === basename(this.root)) {
      this.#notify()
      void this.#topology(this.root)
      return
    }
    if (metadata) {
      const rel = key(relative(directory, path))
      if (filename !== null && rel.endsWith(".lock")) return
      if (filename !== null && this.#gitDirectories.has(directory) && !/^(HEAD|index|packed-refs|config|config\.worktree|commondir|refs|info)(\/|$)/u.test(rel)) return
    } else {
      const rel = key(relative(this.root, path))
      if (filename !== ".gitignore" && this.#ignored.has(path) && !this.#tracked.has(rel)) return
      // The metadata subscriptions handle .git; watching its contents as files
      // would wake on object writes, reflogs and our own status commands.
      if (rel === ".git" || rel.startsWith(".git/")) {
        if (rel !== ".git") return
        if (event !== "rename" && this.#gitDirectories.has(path)) return
      }
      const external = relative(this.root, directory)
      if (this.#externalIgnore && directory === dirname(this.#externalIgnore) && (external.startsWith(`..${sep}`) || isAbsolute(external)) && path !== this.#externalIgnore) return
      if (this.#repository && filename !== null && rel !== ".git" && filename !== ".gitignore" && path !== this.#externalIgnore && !this.#tracked.has(rel)) {
        this.#candidates.set(path, event === "rename" || this.#candidates.get(path) === true)
        if (!this.#classifying) {
          this.#classifying = true
          setImmediate(() => { void this.#classify() }).unref()
        }
        return
      }
    }
    this.#notify()
    if (filename === null || filename === ".git" || filename === ".gitignore" || path === this.#externalIgnore || metadata && ["index", "config", "config.worktree", "commondir", "exclude"].includes(filename ?? "")) this.#schedule()
    else if (event === "rename") void this.#topology(path)
  }

  async #topology(path: string): Promise<void> {
    try {
      const known = this.#directories.has(path) || this.#submodules.has(path)
      if (!known && !(await lstat(path)).isDirectory()) return
      // A path can name a new inode after replacement, even if it exists again
      // by the time we process the rename. Never reuse that old directory watch.
      for (const [directory, { watcher }] of this.#directories) {
        if (directory === path || directory.startsWith(path + sep)) { watcher.close(); this.#directories.delete(directory) }
      }
      const submodule = this.#submodules.get(path)
      if (submodule) { submodule.close(); this.#submodules.delete(path) }
      this.#schedule()
    } catch (error) { if (!missing(error)) this.#failure(error) }
  }

  async #classify(): Promise<void> {
    try {
      while (this.#candidates.size && !this.#closed) {
        const candidates = new Map(this.#candidates)
        this.#candidates.clear()
        try {
          const input = [...candidates.keys()].map(path => "./" + key(relative(this.root, path))).join("\0") + "\0"
          const ignored = new Set((await git(this.root, ["check-ignore", "--no-index", "-z", "--stdin"], input)).split("\0").filter(Boolean).map(path => resolve(this.root, path)))
          if (this.#closed) return
          // Classify retries no longer always schedule a `#scan`, so clear the
          // streak here; otherwise a recovered lock reduces the next budget.
          this.#configLockStreak = 0
          let changed = false
          for (const [path, topology] of candidates) {
            if (ignored.has(path)) this.#ignored.add(path)
            else { changed = true; if (topology) void this.#topology(path) }
          }
          if (changed) this.#notify()
        } catch (error) {
          if (transientGitConfigLock(error) && await this.#deferConfigLock()) {
            // Rebind rename candidates before retrying: a follow-up `#scan` alone
            // would reuse the old directory inode watch and miss later edits.
            for (const [path, topology] of candidates) {
              this.#candidates.set(path, this.#candidates.get(path) === true || topology)
              if (topology) void this.#topology(path)
            }
            continue
          }
          throw error
        }
      }
    } catch (error) { this.#failure(error) }
    finally { this.#classifying = false }
  }

  #watch(directory: string, metadata: boolean, wanted: Set<string>): void {
    if (this.#closed) return
    if (this.#directories.has(directory)) { wanted.add(directory); return }
    const watcher = watch(directory, { persistent: false }, (event, filename) => this.#event(directory, metadata, event, filename))
    watcher.on("error", error => {
      watcher.close()
      if (this.#directories.get(directory)?.watcher === watcher) this.#directories.delete(directory)
      this.#failure(error)
    })
    this.#directories.set(directory, { watcher, metadata })
    wanted.add(directory)
  }

  async #rebuild(): Promise<void> {
    if (this.#closed) return
    if (this.#rebuilding) { this.#again = true; return this.#rebuilding }
    const pending = (async () => {
      do {
        this.#again = false
        try {
          await this.#scan()
          this.#configLockStreak = 0
          // Writes while a new directory was being discovered must not leave a
          // snapshot cached from before its OS watch became active.
          if (this.#started && !this.#closed) this.#notify()
          this.#started = true
        } catch (error) {
          if (transientGitConfigLock(error) && await this.#deferConfigLock()) {
            this.#again = true
            continue
          }
          this.#failure(error)
        }
      } while (this.#again && !this.#closed)
    })()
    this.#rebuilding = pending
    try { await pending } finally { this.#rebuilding = undefined }
  }

  async #scan(): Promise<void> {
    const wanted = new Set<string>()
    // Subscribe before discovery so a concurrent git init/file creation causes
    // another pass instead of disappearing in the initial snapshot race.
    this.#watch(this.root, false, wanted)
    let repository = true
    let metadata: string[] = []
    try {
      const [root, ...directories] = (await git(this.root, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"])).trimEnd().split("\n")
      repository = await realpath(root!) === this.root
      metadata = repository ? directories : []
    } catch (error) {
      if (!/not a git repository/u.test(detail(error))) throw error
      repository = false
    }
    this.#repository = repository
    if (this.#closed) return
    this.#tracked = new Set()
    const submodules = new Set<string>()
    if (repository) {
      for (const entry of (await git(this.root, ["ls-files", "--stage", "-z"])).split("\0")) {
        if (!entry) continue
        const path = entry.slice(entry.indexOf("\t") + 1)
        if (entry.startsWith("160000 ")) submodules.add(resolve(this.root, path))
        this.#tracked.add(path)
        let parent = path
        while (parent.includes("/")) { parent = parent.slice(0, parent.lastIndexOf("/")); this.#tracked.add(parent) }
      }
    }
    const ignored = new Set<string>()
    let queue = [this.root]
    while (queue.length && !this.#closed) {
      const entries: { path: string; directory: boolean }[] = []
      for (const directory of queue) {
        try {
          this.#watch(directory, false, wanted)
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (entry.name !== ".git") entries.push({ path: join(directory, entry.name), directory: entry.isDirectory() })
          }
        } catch (error) { if (missing(error) && directory !== this.root) continue; throw error }
      }
      const candidates = entries.filter(entry => !this.#tracked.has(key(relative(this.root, entry.path))))
      if (repository && candidates.length) {
        const input = candidates.map(entry => "./" + key(relative(this.root, entry.path))).join("\0") + "\0"
        for (const path of (await git(this.root, ["check-ignore", "--no-index", "-z", "--stdin"], input)).split("\0")) {
          if (path) ignored.add(resolve(this.root, path))
        }
      }
      queue = entries.filter(entry => entry.directory && !ignored.has(entry.path) && !submodules.has(entry.path)).map(entry => entry.path)
    }
    if (this.#closed) return
    this.#ignored = ignored
    for (const path of submodules) {
      const existing = this.#submodules.get(path)
      if (existing) { if (!existing.healthy) await existing.start(); continue }
      try {
        if (!(await lstat(path)).isDirectory()) continue
        const watcher = new GitWatch(path, error => {
          if (error) { this.healthy = false; this.#error = error }
          else if (this.#error) this.#schedule()
          this.#notify()
        })
        this.#submodules.set(path, watcher)
        await watcher.start()
      } catch (error) { if (!missing(error)) throw error }
    }
    for (const [path, watcher] of this.#submodules) if (!submodules.has(path)) { watcher.close(); this.#submodules.delete(path) }
    this.#gitDirectories = new Set(await Promise.all(metadata.map(path => realpath(path))))
    for (const directory of this.#gitDirectories) {
      this.#watch(directory, true, wanted)
      const queue = [join(directory, "refs"), join(directory, "info")]
      while (queue.length && !this.#closed) {
        const nested = queue.shift()!
        try {
          this.#watch(nested, true, wanted)
          for (const entry of await readdir(nested, { withFileTypes: true })) if (entry.isDirectory()) queue.push(join(nested, entry.name))
        } catch (error) { if (!missing(error)) throw error }
      }
    }
    this.#externalIgnore = undefined
    if (repository) {
      const path = (await git(this.root, ["config", "--path", "--get", "core.excludesFile"])).trimEnd()
      if (path) {
        this.#externalIgnore = isAbsolute(path) ? path : resolve(this.root, path)
        try { this.#watch(dirname(this.#externalIgnore), false, wanted) } catch (error) { if (!missing(error)) throw error }
      }
    }
    for (const [directory, { watcher }] of this.#directories) {
      if (!wanted.has(directory)) { watcher.close(); this.#directories.delete(directory) }
    }
    this.healthy = [...wanted].every(path => this.#directories.has(path)) && [...this.#submodules.values()].every(watcher => watcher.healthy)
    if (this.healthy) this.#error = undefined
  }
}
