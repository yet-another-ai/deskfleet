import { parseArgs } from "node:util"
import { remoteAgentSettings } from "@deskfleet/protocol/remote-agent-settings"
import { defaultWorktreePreferences } from "@deskfleet/protocol/worktree-preferences"
import { daemonControlDirectory } from "../control/discovery.ts"
import {
  readRemoteAgentSettings, readWorktreePreferences, readWorktreeRoot,
  writeRemoteAgentSettings, writeWorktreePreferences, writeWorktreeRoot,
} from "./host-settings.ts"

const defaultRemoteAgents = () => remoteAgentSettings({ allowRead: false, allowOperate: false })
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const unknownKey = (key: string) => new Error(`Unknown setting key: ${key}. Run 'deskfleet-daemon settings --help' to list supported keys.`)

function defaultTree() {
  return { remoteAgents: defaultRemoteAgents(), worktrees: { root: null as string | null, ...defaultWorktreePreferences() } }
}

function readPath(root: Record<string, unknown>, path: string[], key: string): unknown {
  let current: unknown = root
  for (const segment of path) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) throw unknownKey(key)
    current = current[segment]
  }
  return current
}

function replacePath<T extends Record<string, unknown>>(target: T, path: string[], value: unknown): T {
  const [head, ...tail] = path
  if (!head) return value as T
  return { ...target, [head]: tail.length ? replacePath(target[head] as Record<string, unknown>, tail, value) : value }
}

function parseValue(key: string, raw: string, sample: unknown): unknown {
  if (typeof sample === "boolean") {
    if (raw === "true" || raw === "false") return raw === "true"
    throw new Error(`Invalid value for ${key}: expected true or false`)
  }
  if (typeof sample === "number") {
    if (/^\d+$/u.test(raw)) return Number(raw)
    throw new Error(`Invalid value for ${key}: expected a whole number`)
  }
  return raw
}

function usage(): string {
  const defaults = defaultTree()
  const lines = [
    "Usage: deskfleet-daemon settings [get [key] | set <key> <value> | reset <key>]",
    "",
    "Keys (stored in $DESKFLEET_DAEMON_DIRECTORY or ~/.deskfleet; apply immediately):",
  ]
  const visit = (prefix: string, value: unknown): void => {
    if (!isRecord(value)) { lines.push(`  ${prefix}  (default: ${JSON.stringify(value)})`); return }
    for (const [name, child] of Object.entries(value)) visit(prefix ? `${prefix}.${name}` : name, child)
  }
  visit("", defaults)
  lines.push("", "Sections accepted by get/reset: remoteAgents, worktrees, worktrees.cleanup")
  return lines.join("\n")
}

async function getSetting(directory: string, key?: string): Promise<unknown> {
  if (!key) {
    return {
      remoteAgents: await readRemoteAgentSettings(directory),
      worktrees: { root: await readWorktreeRoot(directory), ...await readWorktreePreferences(directory) },
    }
  }
  const path = key.split(".")
  readPath(defaultTree(), path, key)
  if (path[0] === "remoteAgents") return readPath(await readRemoteAgentSettings(directory), path.slice(1), key)
  if (key === "worktrees.root") return readWorktreeRoot(directory)
  if (key === "worktrees") return { root: await readWorktreeRoot(directory), ...await readWorktreePreferences(directory) }
  return readPath(await readWorktreePreferences(directory) as unknown as Record<string, unknown>, path.slice(1), key)
}

async function writeSetting(directory: string, key: string, raw?: string): Promise<unknown> {
  const path = key.split(".")
  const fallback = readPath(defaultTree(), path, key)
  if (raw !== undefined && isRecord(fallback)) throw unknownKey(key)
  const next = raw === undefined ? fallback : parseValue(key, raw, fallback)

  if (path[0] === "remoteAgents") {
    const updated = replacePath(await readRemoteAgentSettings(directory), path.slice(1), next)
    return writeRemoteAgentSettings(directory, updated)
  }
  if (key === "worktrees") {
    await writeWorktreeRoot(directory, null)
    return { root: null, ...await writeWorktreePreferences(directory, defaultWorktreePreferences()) }
  }
  if (key === "worktrees.root") {
    if (raw === "null") throw new Error("Use 'deskfleet-daemon settings reset worktrees.root' to restore the default worktree root")
    const root = raw === undefined ? null : raw
    await writeWorktreeRoot(directory, root)
    return { root }
  }
  const current = await readWorktreePreferences(directory) as unknown as Record<string, unknown>
  return writeWorktreePreferences(directory, replacePath(current, path.slice(1), next) as unknown as ReturnType<typeof defaultWorktreePreferences>)
}

export async function runSettingsCli(args: string[], dependencies: { directory?: string; log?: (line: string) => void } = {}): Promise<void> {
  const log = dependencies.log ?? console.log
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { help: { type: "boolean", short: "h" } } })
  if (values.help || positionals[0] === "help") { log(usage()); return }
  const directory = dependencies.directory ?? daemonControlDirectory()
  const [action, ...rest] = positionals
  if (!action || action === "get") {
    if (rest.length > 1) throw new Error("Usage: deskfleet-daemon settings get [key]")
    log(JSON.stringify(await getSetting(directory, rest[0]), null, 2))
  } else if (action === "set") {
    if (rest.length !== 2) throw new Error("Usage: deskfleet-daemon settings set <key> <value>")
    log(JSON.stringify(await writeSetting(directory, rest[0]!, rest[1]!), null, 2))
  } else if (action === "reset") {
    if (rest.length !== 1) throw new Error("Usage: deskfleet-daemon settings reset <key>")
    log(JSON.stringify(await writeSetting(directory, rest[0]!), null, 2))
  } else {
    throw new Error(`Unknown settings action: ${action}. Use get, set, or reset.`)
  }
}
