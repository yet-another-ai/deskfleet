import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

const POINTER = "active-machine.json"

/** Read only after acquiring the host discovery lease. Existing roots never move. */
export async function activeMachineDirectory(hostDirectory: string): Promise<string> {
  let value: unknown
  try { value = JSON.parse(await readFile(join(hostDirectory, POINTER), "utf8")) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return join(hostDirectory, "machine")
    throw error
  }
  if (!value || typeof value !== "object" || !("directory" in value) || typeof value.directory !== "string"
    || !/^machines\/[a-f0-9-]{36}$/u.test(value.directory)) throw new Error("Invalid active machine directory")
  return join(hostDirectory, value.directory)
}

export async function newMachineDirectory(hostDirectory: string): Promise<{ path: string; activate(): Promise<void> }> {
  const directory = `machines/${randomUUID()}`
  const path = join(hostDirectory, directory)
  await mkdir(path, { recursive: true, mode: 0o700 })
  return {
    path,
    async activate() {
      const temporary = join(hostDirectory, `${POINTER}.tmp`)
      await writeFile(temporary, JSON.stringify({ directory }), { mode: 0o600 })
      await rename(temporary, join(hostDirectory, POINTER))
    },
  }
}
