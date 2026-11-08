import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { computed } from "vue"
import { afterEach, expect, test } from "vitest"
import { accountSessionKey, createAccountSession, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import type { ConversationTool } from "../../services/agent-conversation.ts"
import { agentResourceContextKey } from "../../services/agent-resources.ts"
import { agentPermission } from "../../test/agent.ts"
import { fakeCentral, machineFixture } from "../../test/central.ts"
import AgentToolCall from "./AgentToolCall.vue"

const screenshot = { type: "image" as const, data: "c2NyZWVuc2hvdA==", mimeType: "image/png" }
const remoteArguments = { machineId: "target", serverId: "auv", name: "invoke", arguments: { command_id: "display.capture", inputs: {} } }
const wrappers: VueWrapper[] = []
let session: AccountSession | undefined
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  session?.dispose()
  session = undefined
})

function codexTool(overrides: Partial<ConversationTool> = {}): ConversationTool {
  return {
    toolCallId: "remote-call", title: "mcp.deskfleet.deskfleet_remote_mcp_call", status: "completed",
    rawInput: { server: "deskfleet", tool: "deskfleet_remote_mcp_call", arguments: remoteArguments },
    rawOutput: { result: { content: [screenshot] }, error: null },
    ...overrides,
  }
}

function render(tool = codexTool(), options: { live?: boolean; defaultOpen?: boolean; permission?: ReturnType<typeof agentPermission>; teamId?: string } = {}) {
  const wrapper = mount(AgentToolCall, {
    props: { tool, live: options.live, defaultOpen: options.defaultOpen, permission: options.permission },
    global: {
      plugins: [i18n],
      provide: {
        ...(session ? { [accountSessionKey as symbol]: session } : {}),
        ...(options.teamId ? { [agentResourceContextKey as symbol]: computed(() => ({ target: { kind: "machine", machineId: "source", teamId: options.teamId! }, sessionId: "session" })) } : {}),
      },
      stubs: {
        PreviewViewer: { props: ["content", "title", "mimeType"], template: '<img data-remote-preview :src="content" :alt="title" />' },
        AgentContent: { template: "<div data-agent-content />" },
      },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

test("Codex remote calls show the machine, action and screenshot while raw details stay collapsed", async () => {
  session = createAccountSession(fakeCentral({ machines: [machineFixture("target", "team-1", "Studio Mac")] }).central)
  await flushPromises()
  const view = render(codexTool(), { defaultOpen: true })

  const card = view.get("[data-remote-mcp-card]")
  expect(card.text()).toContain("Studio Mac")
  expect(card.text()).toContain("display.capture")
  expect(card.get("[data-remote-preview]").attributes("src")).toBe("data:image/png;base64,c2NyZWVuc2hvdA==")
  expect(card.get("[data-remote-mcp-details]").attributes("aria-expanded")).toBe("false")
  expect(card.find("pre").exists()).toBe(false)

  await card.get("[data-remote-mcp-details]").trigger("click")
  expect(card.get("[data-remote-mcp-details]").attributes("aria-expanded")).toBe("true")
  expect(card.text()).toContain('"machineId": "target"')
  expect(card.text()).toContain('"command_id": "display.capture"')
})

test("Claude image content and raw image output produce one visible screenshot", () => {
  const view = render(codexTool({
    title: "mcp__deskfleet__deskfleet_remote_mcp_call", rawInput: remoteArguments,
    content: [{ type: "content", content: screenshot }],
    rawOutput: [{ type: "image", source: { type: "base64", media_type: screenshot.mimeType, data: screenshot.data } }],
  }))

  expect(view.get("[data-remote-mcp-card]").text()).toContain("target")
  expect(view.findAll("[data-remote-preview]")).toHaveLength(1)
  expect(view.get("[data-remote-preview]").attributes("src")).toBe("data:image/png;base64,c2NyZWVuc2hvdA==")
})

test("opening remote resource-link details keeps the remote URI as text without mounting source-machine previews", async () => {
  const uri = "file:///remote/screenshots/desktop.png"
  const view = render(codexTool({
    title: "mcp__deskfleet__deskfleet_remote_mcp_call", rawInput: remoteArguments,
    content: [{ type: "content", content: { type: "resource_link", uri, name: "desktop.png", mimeType: "image/png" } }],
    rawOutput: undefined,
  }), { teamId: "team-1" })

  await view.get("[data-remote-mcp-details]").trigger("click")
  expect(view.findAll("pre").map(block => block.text()).join("\n")).toContain(uri)
  expect(view.find("[data-agent-content]").exists()).toBe(false)
  expect(view.find("[data-remote-preview]").exists()).toBe(false)
})

test("machine labels update with the Team directory and retain the target ID when unavailable", async () => {
  session = createAccountSession(fakeCentral().central)
  await flushPromises()
  const view = render()
  expect(view.get("[data-remote-mcp-card]").text()).toContain("target")

  session.machines.value.push(machineFixture("target", "team-1", "Remote workstation"))
  await flushPromises()
  expect(view.get("[data-remote-mcp-card]").text()).toContain("Remote workstation")
  session.machines.value[0]!.name = "Renamed workstation"
  await flushPromises()
  expect(view.get("[data-remote-mcp-card]").text()).toContain("Renamed workstation")
  session.machines.value = []
  await flushPromises()
  expect(view.get("[data-remote-mcp-card]").text()).toContain("target")
  expect(view.text()).not.toContain("Renamed workstation")
})

test("machine labels use the conversation Team even when another Team is selected", async () => {
  session = createAccountSession(fakeCentral().central)
  await flushPromises()
  session.machines.value = [
    machineFixture("target", "team-2", "Unrelated Team machine"),
    machineFixture("target", "team-1", "Conversation Team machine"),
  ]
  session.teamId.value = "team-2"
  const view = render(codexTool(), { teamId: "team-1" })
  expect(view.text()).toContain("Conversation Team machine")
  expect(view.text()).not.toContain("Unrelated Team machine")

  session.machines.value = [machineFixture("target", "team-2", "Unrelated Team machine")]
  await flushPromises()
  expect(view.get("[data-remote-mcp-card]").text()).toContain("target")
  expect(view.text()).not.toContain("Unrelated Team machine")
})

test("a running operation gains its screenshot on completion and stops its running indicator", async () => {
  const view = render(codexTool({ status: "in_progress", rawOutput: undefined }), { live: true })
  expect(view.get("[data-remote-mcp-card]").text()).toContain("display.capture")
  expect(view.get('[role="status"]').text()).toBe("Running")
  expect(view.find("[data-remote-preview]").exists()).toBe(false)

  await view.setProps({ tool: codexTool(), live: false })
  expect(view.find('[role="status"]').exists()).toBe(false)
  expect(view.find("[data-remote-preview]").exists()).toBe(true)
  expect(view.get("[data-remote-mcp-details]").attributes("aria-expanded")).toBe("false")
})

test("remote failure stays visible, including MCP isError inside a completed provider call", async () => {
  const view = render(codexTool({ status: "failed", rawOutput: "Permission denied" }))
  expect(view.get("[data-remote-mcp-card]").text()).toContain("Failed")

  await view.setProps({ tool: codexTool({ rawOutput: { result: { isError: true, content: [{ type: "text", text: "Screenshot failed" }] }, error: null } }) })
  expect(view.get("[data-remote-mcp-card]").text()).toContain("Failed")
})

test("remote operations preserve pending and resolved permission information", async () => {
  const permission = agentPermission()
  const view = render(codexTool({ status: "pending", rawOutput: undefined }), { permission, live: true })
  expect(view.get("[data-remote-mcp-card]").text()).toContain("Awaiting approval")
  expect(view.get("[data-remote-mcp-card]").attributes("data-permission-id")).toBe(permission.id)

  await view.setProps({ permission: { ...permission, state: "resolved", optionId: "allow" } })
  expect(view.text()).toContain("Allow once")
  expect(view.text()).not.toContain("Awaiting approval")
})

test("ordinary tools keep the existing collapsed rendering and show localized targets", async () => {
  const view = render({ toolCallId: "read", title: "Read settings", rawInput: { path: "settings.json" } })
  expect(view.find("[data-remote-mcp-card]").exists()).toBe(false)
  expect(view.text()).toBe("Read settings")
  expect(view.get("button").attributes("aria-expanded")).toBe("false")

  await view.setProps({ tool: { toolCallId: "read-file", title: "Running view_file", kind: "read", rawInput: { file_path: "/Users/dev/session-worktrees/65/repo-0/src/settings.ts" } } })
  expect(view.text()).toBe("Read src/settings.ts")
  await view.setProps({ tool: { toolCallId: "edit-file", title: "Editing files", kind: "edit", content: [{ type: "diff", path: "src/App.vue", newText: "<template />" }] } })
  expect(view.text()).toBe("Edit src/App.vue")
  await view.setProps({ tool: { toolCallId: "run-cmd", title: "\"pnpm test\"", kind: "execute", rawInput: { command: "/bin/zsh -lc \"pnpm test\"" } } })
  expect(view.text()).toBe("Run pnpm test")
})
