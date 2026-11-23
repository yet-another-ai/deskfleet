import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { remoteAgentSettings, type RemoteAgentSettings } from "@deskfleet/protocol/remote-agent-settings"
import { defaultWorktreePreferences, validateWorktreePreferences, type WorktreePreferences } from "@deskfleet/protocol/worktree-preferences"

// Host settings apply to every Team registration and to daemons already running
// independently of the desktop app, so each read goes to disk.
const REMOTE_AGENT_SETTINGS = "remote-agent-settings.json"
const WORKTREE_PREFERENCES = "worktree-preferences.json"
const WORKTREE_SETTINGS = "worktree-settings.json"

async function readSettings<T>(directory: string, filename: string, parse: (value: unknown) => T, missing: () => T): Promise<T> {
  let value: unknown
  try { value = JSON.parse(await readFile(join(directory, filename), "utf8")) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return missing()
    throw error
  }
  return parse(value)
}

async function writeSettings(directory: string, filename: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, filename), temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

/** Host-wide consent is read for every remote request. */
export function readRemoteAgentSettings(directory: string) {
  return readSettings(directory, REMOTE_AGENT_SETTINGS, value => {
    // A headless host may configure hosted access or local cross-workspace delegation without peer Agent preferences.
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const keys = Object.keys(value)
      if (keys.length > 0 && keys.every(key => key === "allowSuperAgent" || key === "allowLocalCrossWorkspace")) {
        return remoteAgentSettings({ allowRead: false, allowOperate: false, ...value })
      }
    }
    return remoteAgentSettings(value)
  }, () => remoteAgentSettings({ allowRead: false, allowOperate: false }))
}

export async function writeRemoteAgentSettings(directory: string, value: RemoteAgentSettings): Promise<RemoteAgentSettings> {
  const settings = remoteAgentSettings(value)
  await writeSettings(directory, REMOTE_AGENT_SETTINGS, settings)
  return settings
}

/** One host preference, read independently by each Team's cleanup service. */
export function readWorktreePreferences(directory: string): Promise<WorktreePreferences> {
  return readSettings(directory, WORKTREE_PREFERENCES, validateWorktreePreferences, defaultWorktreePreferences)
}

export async function writeWorktreePreferences(directory: string, value: WorktreePreferences): Promise<WorktreePreferences> {
  const settings = validateWorktreePreferences(value)
  await writeSettings(directory, WORKTREE_PREFERENCES, settings)
  return settings
}

function validateWorktreeRoot(root: unknown): asserts root is string | null {
  if (root !== null && (typeof root !== "string" || !isAbsolute(root) || root.includes("\0"))) {
    throw new Error("Worktree root must be an absolute directory path or null")
  }
}

/** The worktree storage root; null keeps the default location. */
export function readWorktreeRoot(hostDirectory: string): Promise<string | null> {
  return readSettings(hostDirectory, WORKTREE_SETTINGS, value => {
    if (!value || typeof value !== "object" || !("root" in value)) throw new Error("Invalid worktree settings")
    validateWorktreeRoot(value.root)
    return value.root
  }, () => null)
}

export async function writeWorktreeRoot(hostDirectory: string, root: string | null): Promise<void> {
  validateWorktreeRoot(root)
  if (root !== null) {
    await mkdir(root, { recursive: true, mode: 0o700 })
    if (!(await stat(root)).isDirectory()) throw new Error("Worktree root must be a directory")
    await access(root, constants.W_OK | constants.X_OK)
  }
  await writeSettings(hostDirectory, WORKTREE_SETTINGS, { root })
}
