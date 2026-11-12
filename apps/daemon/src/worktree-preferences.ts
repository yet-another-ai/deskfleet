import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export type LocalChangesProtection = "uncommitted" | "all" | "none"
export interface WorktreePreferences {
  branchNaming: "semantic" | "session"
  cleanup: {
    archived: boolean
    merged: boolean
    inactive: boolean
    inactiveDays: number
    settled: boolean
    settledDays: number
    unchanged: boolean
    keepLocalChanges: LocalChangesProtection
  }
}

export function defaultWorktreePreferences(): WorktreePreferences {
  return { branchNaming: "semantic", cleanup: {
    archived: true, merged: true, inactive: true, inactiveDays: 5,
    settled: true, settledDays: 6, unchanged: true, keepLocalChanges: "uncommitted",
  } }
}

export function validateWorktreePreferences(value: unknown): WorktreePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid worktree preferences")
  const input = value as Record<string, unknown>
  if (input.branchNaming !== "semantic" && input.branchNaming !== "session") throw new Error("Invalid worktree branch naming")
  if (!input.cleanup || typeof input.cleanup !== "object" || Array.isArray(input.cleanup)) throw new Error("Invalid worktree cleanup preferences")
  const cleanup = input.cleanup as Record<string, unknown>
  for (const key of ["archived", "merged", "inactive", "settled", "unchanged"]) {
    if (typeof cleanup[key] !== "boolean") throw new Error(`Invalid worktree cleanup preference: ${key}`)
  }
  for (const [key, minimum] of [["inactiveDays", 1], ["settledDays", 0]] as const) {
    if (typeof cleanup[key] !== "number" || !Number.isInteger(cleanup[key]) || cleanup[key] < minimum || cleanup[key] > 3650) {
      throw new Error(`${key} must be a whole number between ${minimum} and 3650`)
    }
  }
  if (!["uncommitted", "all", "none"].includes(cleanup.keepLocalChanges as string)) throw new Error("Invalid local changes protection")
  // Construct plain data at the IPC boundary and drop unrelated keys.
  return { branchNaming: input.branchNaming, cleanup: {
    archived: cleanup.archived as boolean, merged: cleanup.merged as boolean,
    inactive: cleanup.inactive as boolean, inactiveDays: cleanup.inactiveDays as number,
    settled: cleanup.settled as boolean, settledDays: cleanup.settledDays as number,
    unchanged: cleanup.unchanged as boolean, keepLocalChanges: cleanup.keepLocalChanges as LocalChangesProtection,
  } }
}

const FILENAME = "worktree-preferences.json"

/** One host preference, read independently by each Team's cleanup service. */
export async function readWorktreePreferences(directory: string): Promise<WorktreePreferences> {
  try { return validateWorktreePreferences(JSON.parse(await readFile(join(directory, FILENAME), "utf8"))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultWorktreePreferences()
    throw error
  }
}

export async function writeWorktreePreferences(directory: string, value: WorktreePreferences): Promise<WorktreePreferences> {
  const settings = validateWorktreePreferences(value)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, FILENAME), temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600, flag: "wx" })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
  return settings
}
