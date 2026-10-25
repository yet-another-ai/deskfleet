import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

const FILENAME = "worktree-settings.json"

function validateRoot(root: unknown): asserts root is string | null {
  if (root !== null && (typeof root !== "string" || !isAbsolute(root) || root.includes("\0"))) {
    throw new Error("Worktree root must be an absolute directory path or null")
  }
}

/** Host storage preferences also apply to a daemon already running independently. */
export async function readWorktreeRoot(hostDirectory: string): Promise<string | null> {
  let value: unknown
  try { value = JSON.parse(await readFile(join(hostDirectory, FILENAME), "utf8")) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  if (!value || typeof value !== "object" || !("root" in value)) throw new Error("Invalid worktree settings")
  validateRoot(value.root)
  return value.root
}

export async function writeWorktreeRoot(hostDirectory: string, root: string | null): Promise<void> {
  validateRoot(root)
  if (root !== null) {
    await mkdir(root, { recursive: true, mode: 0o700 })
    if (!(await stat(root)).isDirectory()) throw new Error("Worktree root must be a directory")
    await access(root, constants.W_OK | constants.X_OK)
  }
  await mkdir(hostDirectory, { recursive: true, mode: 0o700 })
  const path = join(hostDirectory, FILENAME)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ root }, null, 2) + "\n", { mode: 0o600, flag: "wx" })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}
