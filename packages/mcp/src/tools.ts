import type { Tool } from "@modelcontextprotocol/sdk/types.js"

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
const fields = { title: id, prompt: id, enabled: { type: "boolean" }, target, trigger }

/** The tool surface is independent of an ACP provider and of daemon implementation details. */
export const DESKFLEET_TOOLS: (Tool & { method: string })[] = [
  { name: "deskfleet_remote_machines", method: "remoteMcp/machines", description: "List other online machines in this Session's Team that permit remote Agent access. Returns their IDs and current read/operate permissions.", inputSchema: object({}) },
  { name: "deskfleet_remote_machine", method: "remoteMcp/machine", description: "Read a remote machine's Workspaces, directories and public Agent provider information. Requires the target's read permission.", inputSchema: object({ machineId: id }, ["machineId"]) },
  { name: "deskfleet_remote_sessions", method: "remoteMcp/sessions", description: "List Agent Sessions on another machine, optionally filtered by Workspace. Requires the target's read permission.", inputSchema: object({ machineId: id, workspaceId: id }, ["machineId"]) },
  { name: "deskfleet_remote_session", method: "remoteMcp/session", description: "Read a remote Agent Session's state and conversation snapshot. Requires the target's read permission. Does not send messages or resume the Agent.", inputSchema: object({ machineId: id, sessionId: id }, ["machineId", "sessionId"]) },
  { name: "deskfleet_remote_session_history", method: "remoteMcp/history", description: "Read recorded conversation/tool events on another machine. Start at afterSeq 0 and continue with the last event's seq. Requires read permission.", inputSchema: object({ machineId: id, sessionId: id, afterSeq: { type: "string", pattern: "^[0-9]+$" }, limit: { type: "integer", minimum: 1, maximum: 200 } }, ["machineId", "sessionId", "afterSeq"]) },
  { name: "deskfleet_remote_mcp_servers", method: "remoteMcp/mcpServers", description: "List enabled, configured MCP servers on another machine. Returns server IDs and names without connection credentials. Requires read or operate permission.", inputSchema: object({ machineId: id }, ["machineId"]) },
  { name: "deskfleet_remote_mcp_tools", method: "remoteMcp/mcpTools", description: "Discover a configured remote MCP server's tools and argument schemas. Pass nextCursor as cursor for another page. Requires read or operate permission.", inputSchema: object({ machineId: id, serverId: id, cursor: id }, ["machineId", "serverId"]) },
  { name: "deskfleet_remote_mcp_call", method: "remoteMcp/mcpCall", description: "Call a tool from a configured MCP server on another machine. Use its discovered name and argument schema. Always requires the target's operate permission, including tools marked read-only. A failed or timed-out call may already have taken effect; do not blindly retry. This does not expose DeskFleet Agent messaging or scheduled-task tools.", inputSchema: object({ machineId: id, serverId: id, name: id, arguments: { type: "object", additionalProperties: true } }, ["machineId", "serverId", "name", "arguments"]) },
  { name: "deskfleet_context", method: "catalogList", description: "Read this Agent's authorized machine and Workspace context, including available directories.", inputSchema: object({}) },
  { name: "deskfleet_providers", method: "providerList", description: "List available Agent provider identities for creating scheduled tasks on this machine.", inputSchema: object({}) },
  { name: "deskfleet_sessions", method: "_deskfleet/session/list", description: "List Sessions in this Agent's Workspace.", inputSchema: object({}) },
  { name: "deskfleet_session", method: "_deskfleet/session/subscribe", description: "Inspect a Session in this Agent's Workspace, including its latest execution state.", inputSchema: object({ sessionId: id }, ["sessionId"]) },
  { name: "deskfleet_session_history", method: "_deskfleet/session/history", description: "Read a page of a Workspace Session's recorded events. Continue with the last event's seq as afterSeq.", inputSchema: object({ sessionId: id, afterSeq: { type: "string", pattern: "^[0-9]+$" }, limit: { type: "integer", minimum: 1, maximum: 200 } }, ["sessionId", "afterSeq"]) },
  { name: "deskfleet_schedules", method: "scheduleList", description: "List scheduled tasks and recent runs in this Agent's Workspace.", inputSchema: object({}) },
  { name: "deskfleet_schedule_create", method: "scheduleCreate", description: "Create a scheduled task in this Agent's Workspace. Use an explicit IANA time zone for daily or weekly times. New runs create a Session; existing targets append a prompt to that Session.", inputSchema: object({ schedule: object(fields, ["title", "prompt", "enabled", "target", "trigger"]) }, ["schedule"]) },
  { name: "deskfleet_schedule_update", method: "scheduleUpdate", description: "Update a Workspace scheduled task. Set enabled to false to pause it.", inputSchema: object({ scheduleId: id, changes: object(fields) }, ["scheduleId", "changes"]) },
  { name: "deskfleet_schedule_delete", method: "scheduleDelete", description: "Delete a Workspace scheduled task. Existing Sessions and their history remain available.", inputSchema: object({ scheduleId: id }, ["scheduleId"]) },
  { name: "deskfleet_schedule_run", method: "scheduleRun", description: "Run a Workspace scheduled task now, including a manual task.", inputSchema: object({ scheduleId: id }, ["scheduleId"]) },
]
