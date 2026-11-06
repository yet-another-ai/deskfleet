import { execFile } from "node:child_process"
import { mkdtemp, readFile, realpath, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

interface Options {
  maxBuffer?: number
  timeout?: number
  input?: string
  literalPaths?: boolean
  optionalLocks?: boolean
  acceptExit?: number[]
}

type Runner = (args: string[], options?: Options) => Promise<{ stdout: string; stderr: string }>

let hooks: Promise<string> | undefined

export class GitPolicyError extends Error {}

function environment(options: Options): NodeJS.ProcessEnv {
  const env = { ...process.env }
  // Discard inherited repository paths, config injection, tracing, and helper
  // overrides. Host-owned system/global config and SSH configuration remain trusted.
  for (const name of Object.keys(env)) if (/^GIT_/iu.test(name) || /^SSH_ASKPASS$/iu.test(name)) delete env[name]
  return { ...env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https:ssh:file",
    GIT_LITERAL_PATHSPECS: options.literalPaths ? "1" : "0",
    ...(options.optionalLocks === false ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
  }
}

function run(args: string[], options: Options, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((accept, reject) => {
    const child = execFile("git", args, { env, encoding: "utf8", windowsHide: true,
      timeout: options.timeout ?? 20_000, maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error && !(typeof error.code === "number" && options.acceptExit?.includes(error.code))) {
        // Preserve stdout/code so bounded diff callers can return truncated patches.
        Object.assign(error, { stdout, stderr })
        if (stderr.trim() && !error.message.includes(stderr.trim())) error.message += `\n${stderr.trim()}`
        reject(error)
      } else accept({ stdout, stderr })
    })
    child.stdin?.on("error", () => {})
    child.stdin?.end(options.input)
  })
}

function entries(text: string): [string, string][] {
  return text.split("\0").filter(Boolean).map(entry => {
    const end = entry.indexOf("\n")
    return [end < 0 ? entry : entry.slice(0, end), end < 0 ? "" : entry.slice(end + 1)]
  })
}

// Block known executable and transport policy while allowing unrelated tool metadata.
// New Git operations and configuration features must be reviewed against this list.
function prohibited(key: string): boolean {
  return /^(include|includeif)\./u.test(key)
    || /^credential\.(.+\.)?helper$/u.test(key)
    || /^filter\..+\.(clean|smudge|process|required)$/u.test(key)
    || /^hook\..+\.(command|event)$/u.test(key)
    || /^gpg\.(?:(?:.+\.)?program|ssh\.defaultkeycommand)$/u.test(key)
    || /^http\.(.+\.)?(proxy|proxyauthmethod|proxysslcert|proxysslkey|proxysslcertpasswordprotected|proxysslcerttype|proxysslkeytype|proxysslcainfo|proxysslverify|sslverify|sslcert|sslkey|sslcertpasswordprotected|sslcerttype|sslkeytype|sslcainfo|sslcapath|sslbackend|pinnedpubkey|extraheader|cookiefile)$/u.test(key)
    || /^url\..+\.(insteadof|pushinsteadof)$/u.test(key)
    || /^core\.(fsmonitor|hookspath|sshcommand|gitproxy|askpass|alternaterefscommand)$/u.test(key)
    || /^remote\..+\.(uploadpack|receivepack|proxy|proxyauthmethod|vcs|promisor|partialclonefilter)$/u.test(key)
    || /^branch\..+\.mergeoptions$/u.test(key)
    || /^merge\..+\.driver$/u.test(key)
    || /^submodule\..+\.(update|gitdir)$/u.test(key)
    || /^(extensions\.partialclone|gc\.recentobjectshook)$/u.test(key)
}

async function checkoutRoot(path: string): Promise<string> {
  let directory = await realpath(path)
  for (;;) {
    if (await stat(join(directory, ".git")).then(() => true, () => false)) return directory
    const parent = dirname(directory)
    if (parent === directory) throw new Error("not a git repository")
    directory = parent
  }
}

// Submodules legitimately use core.worktree. Require the configured directory
// to point back to this gitdir, rather than accepting an arbitrary destination.
async function checkWorktree(context: string[], value: string, flags: string[], execute: Runner): Promise<void> {
  const gitdir = await realpath((await execute([...flags, ...context, "rev-parse", "--absolute-git-dir"])).stdout.trimEnd())
  const matches = await (async () => {
    const target = await realpath(resolve(gitdir, value))
    if (context[0] === "-C" && target !== await checkoutRoot(context[1]!)) return false
    const metadata = join(target, ".git")
    if ((await stat(metadata)).isDirectory()) return await realpath(metadata) === gitdir
    const link = (await readFile(metadata, "utf8")).trim()
    return link.startsWith("gitdir: ") && await realpath(resolve(target, link.slice(8))) === gitdir
  })().catch(() => false)
  if (!matches) throw new GitPolicyError("Repository-local core.worktree redirects outside its checkout")
}

async function inspect(context: string[], flags: string[], execute: Runner): Promise<void> {
  let worktreeConfig = false
  for (const scope of ["--local", "--worktree"]) {
    if (scope === "--worktree" && !worktreeConfig) continue
    // Unlike --list, querying keys accepts an absent optional config.worktree.
    // Exit 1 means no keys; malformed or unreadable config still fails.
    const query = scope === "--worktree" ? ["--get-regexp", "."] : ["--list"]
    const { stdout } = await execute([...flags, ...context, "config", scope, "--no-includes", "--null", ...query], { acceptExit: scope === "--worktree" ? [1] : [] }).catch(error => {
      if (String(error.stderr).includes("--local can only be used inside a git repository")) throw new Error("not a git repository")
      throw error
    })
    for (const [key, value] of entries(stdout)) {
      if (key === "core.worktree") await checkWorktree(context, value, flags, execute)
      else if (prohibited(key)) throw new GitPolicyError(`Repository-local Git configuration is not supported by DeskFleet: ${key}`)
      if (key === "extensions.worktreeconfig") {
        worktreeConfig = (await execute([...flags, ...context, "config", "--local", "--no-includes", "--bool", "--get", key])).stdout.trim() === "true"
      }
    }
  }
}

async function inspectCheckout(root: string, flags: string[], execute: Runner, seen: Set<string>): Promise<void> {
  await inspect(["-C", root], flags, execute)
  const top = (await execute([...flags, "-C", root, "rev-parse", "--show-toplevel"])).stdout.trimEnd()
  const physical = await realpath(top)
  if (physical !== await checkoutRoot(root)) throw new GitPolicyError("Git working tree differs from the selected checkout")
  if (seen.has(physical)) return
  if (seen.size >= 128) throw new Error("Too many nested Git repositories")
  seen.add(physical)
  const context = ["-C", physical]
  // Status/diff can enter initialized submodules. Validate their local policy
  // too; fixed -c settings propagate to Git's child commands.
  const { stdout } = await execute([...flags, ...context, "ls-files", "--stage", "-z"])
  for (const entry of stdout.split("\0")) {
    if (!entry.startsWith("160000 ")) continue
    const path = join(physical, entry.slice(entry.indexOf("\t") + 1))
    if (await stat(join(path, ".git")).then(() => true, () => false)) await inspectCheckout(path, flags, execute, seen)
  }
}

/** System Git used by daemon automation, including reads and Session cleanup. */
export async function executeGit(args: string[], options: Options = {}): Promise<{ stdout: string; stderr: string }> {
  const deadline = performance.now() + (options.timeout ?? 20_000)
  const env = environment(options)
  const execute: Runner = (command, commandOptions = {}) => {
    const remaining = Math.ceil(deadline - performance.now())
    if (remaining <= 0) throw Object.assign(new Error("Git automation timed out"), { code: "ETIMEDOUT" })
    return run(command, { ...commandOptions, timeout: remaining }, env)
  }
  hooks ??= mkdtemp(join(tmpdir(), "deskfleet-git-hooks-"))
  const flags = ["--no-pager", "-c", `core.hooksPath=${await hooks}`, "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0"]
  const context = args[0] === "-C" || args[0] === "--git-dir" ? args.slice(0, 2) : undefined
  if (!context || !context[1]) throw new Error("Git automation requires an explicit repository")
  if (context[0] === "-C") await inspectCheckout(context[1], flags, execute, new Set())
  else await inspect(context, flags, execute)
  const config = entries((await execute([...flags, ...context, "config", "--null", "--list"])).stdout)
  // A committed attribute may select any host-configured filter. Disable every
  // discovered driver, including process filters, rather than assuming a name.
  for (const name of new Set(config.flatMap(([key]) => /^filter\.(.+)\.(clean|smudge|process|required)$/u.exec(key)?.[1] ?? []))) {
    for (const field of ["clean", "smudge", "process"]) flags.push("-c", `filter.${name}.${field}=`)
    flags.push("-c", `filter.${name}.required=false`)
  }
  const command = args[2]
  if (command === "fetch" || command === "ls-remote") {
    const separator = args.indexOf("--", 3)
    if (separator < 0 || !args[separator + 1]) throw new Error("Git remote must follow --")
    const remote = args[separator + 1]!
    let url = (await execute([...flags, ...context, "remote", "get-url", remote])).stdout.trimEnd()
    if (url.startsWith("~")) {
      // Use Git's own ~ and ~user expansion, including platform-specific homes.
      url = (await execute([...flags, ...context, "-c", `deskfleet.localremote=${url}`, "config", "--path", "--get", "deskfleet.localremote"])).stdout.trimEnd()
    }
    // Local transports execute upload-pack as this OS user. Validate that
    // repository's metadata as well as the source repository's policy.
    const local = url.startsWith("file:") ? fileURLToPath(url) : isAbsolute(url) || !/^[a-z][a-z0-9+.-]*:|^[^/]+:/iu.test(url) ? resolve(context[0] === "-C" ? context[1] : dirname(context[1]), url) : undefined
    if (local) await inspect(["-C", local], flags, execute)
  }
  const invocation = args.slice()
  if (command === "diff") invocation.splice(3, 0, "--no-ext-diff", "--no-textconv")
  // A per-submodule fetch setting can override submodule.recurse=false. Avoid
  // fetching targets that have not passed the remote policy inspection above.
  if (command === "fetch") invocation.splice(invocation.indexOf("--", 3), 0, "--no-recurse-submodules")
  try {
    return await execute([...flags, ...invocation], options)
  } catch (error) {
    // Only the requested command's output can be interpreted by its caller.
    // Preflight commands use the same runner and can overflow independently.
    if (error instanceof Error && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") Object.assign(error, { gitCommandOutput: true })
    throw error
  }
}
