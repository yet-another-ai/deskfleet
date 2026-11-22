import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

const FILENAME = "remote-agent-settings.json"
const settingsSchema = z.strictObject({
  allowRead: z.boolean(),
  allowOperate: z.boolean(),
  allowSessions: z.boolean().default(false),
  allowWorkspaces: z.boolean().default(false),
  allowSuperAgent: z.boolean().default(false),
})
export type RemoteAgentSettings = z.input<typeof settingsSchema>

export function remoteAgentSettings(value: unknown) {
  return settingsSchema.parse(value)
}

/** Host-wide consent is read for every remote request, including independently running daemons. */
export async function readRemoteAgentSettings(directory: string) {
  try {
    const value: unknown = JSON.parse(await readFile(join(directory, FILENAME), "utf8"))
    // A headless host may configure hosted access without any peer Agent preferences.
    if (value && typeof value === "object" && "allowSuperAgent" in value && Object.keys(value).length === 1)
      return remoteAgentSettings({ allowRead: false, allowOperate: false, ...value })
    return remoteAgentSettings(value)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return remoteAgentSettings({ allowRead: false, allowOperate: false })
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
