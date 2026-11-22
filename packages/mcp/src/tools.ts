import remoteTools from "./remote-tools.json" with { type: "json" }
import { ToolSchema, type Tool } from "@modelcontextprotocol/sdk/types.js"

const id = { type: "string", minLength: 1 }
const object = (properties: Record<string, object>, required: string[] = []) => ({
  type: "object" as const, properties, required, additionalProperties: false,
})
const configuration = object({ model: id, reasoningEffort: id, mode: id })
const trigger = { oneOf: [
  object({ kind: { const: "manual" } }, ["kind"]),
  object({ kind: { const: "daily" }, time: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" }, timeZone: id }, ["kind", "time", "timeZone"]),
  object({ kind: { const: "weekly" }, time: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" }, timeZone: id,
    weekdays: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, minItems: 1, uniqueItems: true, description: "Sunday is 0, Saturday is 6." },
  }, ["kind", "time", "timeZone", "weekdays"]),
  object({ kind: { const: "interval" }, minutes: { type: "integer", minimum: 1 } }, ["kind", "minutes"]),
] }
const target = { oneOf: [
  object({ kind: { const: "new" }, provider: id, context: { enum: ["worktree", "directory"] }, configuration }, ["kind", "provider", "context"]),
  object({ kind: { const: "existing" }, sessionId: id }, ["kind", "sessionId"]),
] }
const fields = { title: id, prompt: id, enabled: { type: "boolean" }, yolo: { type: "boolean", description: "When true, dispatched Sessions auto-approve permission requests. Omit or false keeps manual approval." }, target, trigger }
const sessionFields = {
  provider: id,
  context: { enum: ["worktree", "directory"] },
  title: id,
  prompt: id,
  baseBranch: id,
  yolo: {
    type: "boolean",
    description: "Auto-approve permission requests in the created Session. Defaults to true when the parent Session is YOLO (pass false to opt down); rejected when the parent Session is not YOLO.",
  },
  configuration,
}
const directories = {
  type: "array",
  items: object({ path: id }, ["path"]),
  minItems: 1,
  description: "Ordered absolute directory paths; the first directory is the Workspace default.",
}

/** The tool surface is independent of an ACP provider and of daemon implementation details. */
export const DESKFLEET_TOOLS: (Tool & { method: string })[] = [
  ...remoteTools.map(({ operation, ...definition }) => ({
    ...ToolSchema.parse(definition), method: `remoteMcp/${operation}`,
  })),
  { name: "deskfleet_remote_files", method: "remoteMcp/files", description: "List a directory or stat a file or directory on another machine. Omit path when listing to inspect the remote machine's home directory and filesystem roots. Requires read or operate permission.", inputSchema: object({ machineId: id, operation: { enum: ["list", "stat"] }, path: id }, ["machineId"]) },
  { name: "deskfleet_remote_file_upload", method: "remoteMcp/fileUpload", description: "Upload a local file or directory to a destination directory on another machine. Requires the target's operate permission.", inputSchema: object({ machineId: id, sourcePath: id, destinationDirectory: id, conflict: { enum: ["ask", "replace", "rename", "skip"] } }, ["machineId", "sourcePath", "destinationDirectory"]) },
  { name: "deskfleet_remote_file_download", method: "remoteMcp/fileDownload", description: "Download a file or directory from another machine into a local destination directory. Requires the target's read or operate permission.", inputSchema: object({ machineId: id, sourcePath: id, destinationDirectory: id, conflict: { enum: ["ask", "replace", "rename", "skip"] } }, ["machineId", "sourcePath", "destinationDirectory"]) },
  { name: "deskfleet_context", method: "catalogList", description: "Read this Agent's authorized machine and Workspace context, including available directories.", inputSchema: object({}) },
  { name: "deskfleet_workspace_create", method: "workspaceCreate", description: "Create a Workspace on this machine from one or more existing absolute directory paths; the first path is the default directory. Available to machine-scoped Sessions.", inputSchema: object({ name: id, directories }, ["name", "directories"]) },
  { name: "deskfleet_providers", method: "providerList", description: "List available Agent provider identities for creating Sessions and scheduled tasks on this machine.", inputSchema: object({}) },
  { name: "deskfleet_sessions", method: "_deskfleet/session/list", description: "List Sessions in this Agent's delegation scope (its Workspace, or itself and all Workspace Sessions when machine-scoped or cross-workspace delegation is enabled).", inputSchema: object({}) },
  { name: "deskfleet_session", method: "_deskfleet/session/subscribe", description: "Inspect a Session in this Agent's delegation scope, including its latest execution state.", inputSchema: object({ sessionId: id }, ["sessionId"]) },
  { name: "deskfleet_session_history", method: "_deskfleet/session/history", description: "Read a page of recorded events for a Session in this Agent's delegation scope. Continue with the last event's seq as afterSeq.", inputSchema: object({ sessionId: id, afterSeq: { type: "string", pattern: "^[0-9]+$" }, limit: { type: "integer", minimum: 1, maximum: 200 } }, ["sessionId", "afterSeq"]) },
  { name: "deskfleet_session_create", method: "_deskfleet/session/create", description: "Create a Session on this machine and optionally submit its first prompt. Workspace Sessions default to their own Workspace (and can target sibling Workspaces when cross-workspace delegation is enabled); machine-scoped Sessions can target a Workspace or omit workspaceId to use the home directory.", inputSchema: object({ workspaceId: id, ...sessionFields }, ["provider"]) },
  { name: "deskfleet_session_send", method: "_deskfleet/input/submit", description: "Submit a prompt to a Session in this Agent's delegation scope. Backlog messages resume a stopped or interrupted Session; steer messages require an active turn.", inputSchema: object({ sessionId: id, prompt: id, delivery: { enum: ["backlog", "steer"] }, turnId: id }, ["sessionId", "prompt"]) },
  { name: "deskfleet_schedules", method: "scheduleList", description: "List scheduled tasks and recent runs in this Agent's Workspace.", inputSchema: object({}) },
  { name: "deskfleet_schedule_create", method: "scheduleCreate", description: "Create a scheduled task in this Agent's Workspace. Use an explicit IANA time zone for daily or weekly times. New runs create a Session; existing targets append a prompt to that Session. Optional yolo auto-approves permission requests on dispatched Sessions.", inputSchema: object({ schedule: object(fields, ["title", "prompt", "enabled", "target", "trigger"]) }, ["schedule"]) },
  { name: "deskfleet_schedule_update", method: "scheduleUpdate", description: "Update a Workspace scheduled task. Set enabled to false to pause it. Optional yolo controls permission auto-approval for future dispatches.", inputSchema: object({ scheduleId: id, changes: object(fields) }, ["scheduleId", "changes"]) },
  { name: "deskfleet_schedule_delete", method: "scheduleDelete", description: "Delete a Workspace scheduled task. Existing Sessions and their history remain available.", inputSchema: object({ scheduleId: id }, ["scheduleId"]) },
  { name: "deskfleet_schedule_run", method: "scheduleRun", description: "Run a Workspace scheduled task now, including a manual task.", inputSchema: object({ scheduleId: id }, ["scheduleId"]) },
]
