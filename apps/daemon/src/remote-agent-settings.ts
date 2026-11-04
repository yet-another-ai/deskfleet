import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface RemoteAgentSettings { allowRead: boolean; allowOperate: boolean }
const FILENAME = "remote-agent-settings.json"

export function remoteAgentSettings(value: unknown): RemoteAgentSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !("allowRead" in value) || typeof value.allowRead !== "boolean"
    || !("allowOperate" in value) || typeof value.allowOperate !== "boolean"
    || Object.keys(value).some(key => key !== "allowRead" && key !== "allowOperate")) {
    throw new Error("Remote Agent settings must contain boolean read and operate preferences")
  }
  return { allowRead: value.allowRead, allowOperate: value.allowOperate }
}

/** Host-wide consent is read for every remote request, including independently running daemons. */
export async function readRemoteAgentSettings(directory: string): Promise<RemoteAgentSettings> {
  try { return remoteAgentSettings(JSON.parse(await readFile(join(directory, FILENAME), "utf8"))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { allowRead: false, allowOperate: false }
    throw error
  }
}

export async function writeRemoteAgentSettings(directory: string, value: RemoteAgentSettings): Promise<RemoteAgentSettings> {
  const settings = remoteAgentSettings(value)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, FILENAME), temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600, flag: "wx" })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
  return settings
}
