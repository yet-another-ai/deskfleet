import { z } from "zod"

const settingsSchema = z.strictObject({
  allowRead: z.boolean(),
  allowOperate: z.boolean(),
  allowSessions: z.boolean().default(false),
  allowWorkspaces: z.boolean().default(false),
  allowSuperAgent: z.boolean().default(false),
  allowLocalCrossWorkspace: z.boolean().default(false),
})
export type RemoteAgentSettings = z.input<typeof settingsSchema>

export function remoteAgentSettings(value: unknown) {
  return settingsSchema.parse(value)
}
