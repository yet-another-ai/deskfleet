import { expect, test } from "vitest"
import type { ConversationTool } from "./agent-conversation.ts"
import { isRemoteMcpTool, remoteMcpTool } from "./remote-mcp-tool.ts"

const input = { machineId: "target-machine", serverId: "auv-server", name: "invoke", arguments: { command_id: "display.capture", inputs: {} } }
const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" }
function tool(overrides: Partial<ConversationTool> = {}): ConversationTool {
  return { toolCallId: "remote-call", title: "deskfleet_remote_mcp_call", rawInput: input, ...overrides }
}

test("reads Codex MCP envelopes and screenshots from the original MCP result", () => {
  const call = tool({
    title: "mcp.deskfleet.deskfleet_remote_mcp_call",
    rawInput: { server: "deskfleet", tool: "deskfleet_remote_mcp_call", arguments: input },
    rawOutput: { result: { content: [{ type: "text", text: "Captured" }, image], structuredContent: { width: 1920 } }, error: null },
  })
  expect(isRemoteMcpTool(call)).toBe(true)
  expect(remoteMcpTool(call)).toEqual({ machineId: "target-machine", serverId: "auv-server", toolName: "invoke", action: "display.capture", images: [{ data: image.data, mimeType: image.mimeType }], isError: false })
})

test("reads Claude ACP images and deduplicates their raw tool result copies", () => {
  const call = tool({
    title: "mcp__deskfleet__deskfleet_remote_mcp_call",
    content: [{ type: "content", content: image }],
    rawOutput: [{ type: "image", source: { type: "base64", data: image.data, media_type: image.mimeType } }, { ...image, data: "c2Vjb25k" }],
  })
  expect(remoteMcpTool(call)?.images).toEqual([{ data: image.data, mimeType: image.mimeType }, { data: "c2Vjb25k", mimeType: "image/png" }])
})

test("shows AUV artifact image reads and operations even without a screenshot", () => {
  expect(remoteMcpTool(tool({ rawInput: { ...input, name: "artifact_read_image", arguments: { run_id: "run", artifact_id: "image" } }, rawOutput: { content: [image] } })))
    .toMatchObject({ toolName: "artifact_read_image", action: undefined, images: [{ data: image.data, mimeType: image.mimeType }] })
  expect(remoteMcpTool(tool({ rawInput: { ...input, name: "op_run", arguments: { operation: "player.start", mode: "verified" } } })))
    .toMatchObject({ action: "player.start", images: [], isError: false })
  expect(remoteMcpTool(tool({ rawInput: { ...input, arguments: { action: "click", x: 40, y: 60 } } }))?.action).toBe("click")
  expect(remoteMcpTool(tool({ rawInput: { ...input, arguments: { command_id: "input.typeText", action: "ignored" } } }))?.action).toBe("input.typeText")
})

test("retains error status from ACP, MCP, and Codex transport failures", () => {
  for (const call of [
    tool({ status: "failed" }),
    tool({ rawOutput: { isError: true, content: [{ type: "text", text: "Denied" }] } }),
    tool({ rawOutput: { result: { isError: true, content: [image] }, error: null } }),
    tool({ rawOutput: { result: null, error: { message: "Disconnected" } } }),
  ]) expect(remoteMcpTool(call)?.isError).toBe(true)
})

test("recognizes serialized input and exact provider tool names without claiming other tools", () => {
  expect(isRemoteMcpTool(tool({ title: "functions.mcp__deskfleet__deskfleet_remote_mcp_call", rawInput: JSON.stringify(input) }))).toBe(true)
  expect(isRemoteMcpTool(tool({ title: "Remote operation", rawInput: { server: "deskfleet", tool: "deskfleet_remote_mcp_call", arguments: input } }))).toBe(true)
  for (const call of [
    tool({ title: "other_tool" }),
    tool({ title: "deskfleet_remote_mcp_call_extra" }),
    tool({ title: "Explain deskfleet_remote_mcp_call" }),
    tool({ rawInput: "{" }),
    tool({ rawInput: [] }),
    tool({ rawInput: { ...input, machineId: " " } }),
    tool({ rawInput: { ...input, serverId: null } }),
    tool({ rawInput: { ...input, name: 42 } }),
    tool({ rawInput: undefined }),
  ]) {
    expect(isRemoteMcpTool(call)).toBe(false)
    expect(remoteMcpTool(call)).toBeUndefined()
  }
})

test("ignores malformed image blocks and does not interpret text or unrelated structured data as screenshots", () => {
  const call = tool({ rawOutput: {
    content: [null, { type: "text", text: JSON.stringify(image) }, { ...image, mimeType: "text/plain" }, { ...image, data: null }, { ...image, mimeType: "image/png;fake" }, { type: "image", source: { type: "url", url: "https://example.test/image.png" } }],
    structuredContent: { content: [image] },
  } })
  expect(remoteMcpTool(call)?.images).toEqual([])
})

test("activity detection never reads screenshot output", () => {
  const call = tool()
  Object.defineProperty(call, "rawOutput", { get() { throw new Error("Should not read images") } })
  Object.defineProperty(call, "content", { get() { throw new Error("Should not read images") } })
  expect(isRemoteMcpTool(call)).toBe(true)
})

test("normalizes remote file list, stat, upload, and download tools into remote cards", () => {
  expect(remoteMcpTool({
    toolCallId: "files-list",
    title: "mcp.deskfleet.deskfleet_remote_files",
    rawInput: { machineId: "machine-3", path: "C:\\Games\\TransportFever3" },
  })).toEqual({
    machineId: "machine-3",
    serverId: "deskfleet",
    toolName: "deskfleet_remote_files",
    action: "list C:\\Games\\TransportFever3",
    images: [],
    isError: false,
  })
  expect(remoteMcpTool({
    toolCallId: "files-upload",
    title: "mcp__deskfleet__deskfleet_remote_file_upload",
    rawInput: { machineId: "machine-3", sourcePath: "/Users/lemonneko/profile.lua", destinationDirectory: "C:\\Games\\TransportFever3" },
  })).toEqual({
    machineId: "machine-3",
    serverId: "deskfleet",
    toolName: "deskfleet_remote_file_upload",
    action: "upload /Users/lemonneko/profile.lua → C:\\Games\\TransportFever3",
    images: [],
    isError: false,
  })
  expect(remoteMcpTool({
    toolCallId: "files-download",
    title: "deskfleet_remote_file_download",
    rawInput: { server: "deskfleet", tool: "deskfleet_remote_file_download", arguments: { machineId: "machine-3", sourcePath: "C:\\Games\\TransportFever3\\save", destinationDirectory: "/Users/lemonneko/backup" } },
  })).toEqual({
    machineId: "machine-3",
    serverId: "deskfleet",
    toolName: "deskfleet_remote_file_download",
    action: "download C:\\Games\\TransportFever3\\save → /Users/lemonneko/backup",
    images: [],
    isError: false,
  })
})

