import type { AgentEvent, AgentInput, AgentSessionRecord, AgentSnapshot } from "../../../../../apps/daemon/src/agent-protocol.ts"
import type { AgentConfiguration } from "../../../../../apps/daemon/src/agent-configuration-protocol.ts"
import type { MachineSummary } from "../../../../../packages/components/src/stores/fleet-types.ts"
import type { ProviderDisplay } from "../../../../../packages/client/src/providers.ts"

export const demoProviders: ProviderDisplay[] = [
  { id: "claude-code", name: "Claude Code", template: "claude-code" },
  { id: "codex", name: "Codex", template: "codex" },
  { id: "cursor", name: "Cursor", template: "cursor" },
  { id: "grok", name: "Grok", template: "grok" },
]

export function configuration(provider: string, model?: string, reasoningEffort?: string): AgentConfiguration {
  return {
    provider: demoProviders.find(item => item.id === provider) ?? demoProviders[0]!,
    models: { id: "model", currentValue: model ?? "default", options: [{ id: "default", name: "Default" }] },
    reasoningEfforts: { id: "reasoning_effort", currentValue: reasoningEffort ?? "medium", options: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }, { id: "high", name: "High" }] },
    modes: null,
  }
}

export function input(id: string, sessionId: string, content: string | AgentInput["content"], author: string, state: AgentInput["state"] = "delivered"): AgentInput {
  const blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : content
  return { id, sessionId, submissionCommandId: `submit-${id}`, author: { kind: "user", userId: author }, content: blocks, acceptedSeq: id, state, requestedDelivery: "backlog", actualDelivery: state === "delivered" ? "turn_start" : undefined, createdAt: "" }
}

export function fixtures(chinese: boolean) {
  const say = (en: string, zh: string) => chinese ? zh : en
  const sessions: AgentSessionRecord[] = [
    { id: "301", workspaceId: "201", provider: "claude-code", title: say("Polish the homepage", "完善主页"), context: "worktree", lifecycle: "ready", archiveState: "active", lastEventSeq: "0", createdAt: "", updatedAt: "", capabilities: { steering: true, resume: true } },
    { id: "302", workspaceId: "202", provider: "codex", title: say("Add session search", "添加会话搜索"), context: "worktree", lifecycle: "ready", archiveState: "active", lastEventSeq: "0", createdAt: "", updatedAt: "", capabilities: { steering: true, resume: true } },
    { id: "303", workspaceId: "201", provider: "claude-code", title: say("Keyboard navigation", "键盘导航"), context: "worktree", lifecycle: "ready", archiveState: "active", lastEventSeq: "0", createdAt: "", updatedAt: "", capabilities: { steering: true, resume: true } },
  ]
  const machine: MachineSummary = { id: "demo-machine", name: "Studio Mac", local: false, online: true, desktop: true, terminals: [], sessions: [], workspaces: [
    { id: "201", name: "website", directories: [{ path: "/workspace/website" }], terminals: [], sessions: [] },
    { id: "202", name: "api", directories: [{ path: "/workspace/api" }], terminals: [], sessions: [] },
  ] }
  const snapshots: Record<string, AgentSnapshot> = {}
  const events: Record<string, AgentEvent[]> = {}
  for (const session of sessions) {
    const group = machine.workspaces.find(workspace => workspace.id === session.workspaceId)!
    const provider = demoProviders.find(provider => provider.id === session.provider)!
    group.sessions.push({ id: session.id, title: session.title, provider: provider.name, providerTemplate: provider.template, archiveState: "active", context: "worktree", worktree: { id: String(Number(session.id) + 100), terminals: [], directories: [{ path: `/workspace/.worktrees/${session.id}`, git: { branch: `deskfleet/${session.id}`, head: "84b7f21", changes: [{ path: "src/WorkspacePicker.vue", status: "modified", additions: 7, deletions: 2 }] } }] } })
    const isTeam = session.id === "303"
    const prompt = input(`${session.id}1`, session.id, isTeam ? say("Add keyboard navigation to the workspace picker.", "给工作空间选择器添加键盘导航。") : session.id === "302" ? say("Add search by session title.", "添加按会话标题搜索的功能。") : say("Refine the homepage using our existing components.", "复用现有组件，完善主页。"), "Maya")
    const snapshot: AgentSnapshot = { session: { ...session }, runs: [{ sessionId: session.id, generation: 1, state: "running", startedAt: "" }], inputs: [prompt], turns: [{ id: `turn-${session.id}`, sessionId: session.id, initialInputId: prompt.id, dispatchCommandId: `dispatch-${session.id}`, runGeneration: 1, state: session.id === "302" ? "completed" : "running", startedAt: "" }], permissions: [], elicitations: [] }
    const journal: AgentEvent[] = []
    const append = (kind: AgentEvent["kind"], payload: AgentEvent["payload"]) => journal.push({ sessionId: session.id, seq: String(journal.length + 1), kind, payload, createdAt: "", runGeneration: 1, turnId: `turn-${session.id}` })
    append("input", prompt)
    if (isTeam) {
      const teammate = input("3032", session.id, say("Please keep the current focus styles.", "请保留现有的焦点样式。"), "Alex")
      teammate.actualDelivery = "steer"
      snapshot.inputs.push(teammate)
      append("input", teammate)
    }
    append("acp", { sessionId: session.id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: isTeam ? say("The picker now supports arrow keys, Enter, and Escape. I’ll run the checks before we review the change.", "选择器现在支持方向键、回车和 Esc。一起审查之前，我会先运行检查。") : say("The change is ready for review. I kept the existing components and updated the behavior in place.", "修改已准备好，可以审查了。我保留了现有组件，并更新了对应行为。") } } })
    append("acp", { sessionId: session.id, update: { sessionUpdate: "plan", entries: [{ content: say("Read the existing components", "阅读现有组件"), priority: "medium", status: "completed" }, { content: say("Implement the change", "完成修改"), priority: "medium", status: "completed" }, { content: say("Run focused checks", "运行相关检查"), priority: "medium", status: isTeam ? "in_progress" : "completed" }] } })
    if (isTeam) {
      snapshot.permissions.push({ id: "501", sessionId: session.id, runGeneration: 1, turnId: `turn-${session.id}`, state: "pending", createdAt: "", request: { sessionId: session.id, toolCall: { toolCallId: "test-picker", title: "pnpm test WorkspacePicker", kind: "execute", status: "pending", rawInput: { command: "pnpm test WorkspacePicker" } }, options: [{ optionId: "allow", name: say("Allow once", "允许一次"), kind: "allow_once" }, { optionId: "deny", name: say("Reject", "拒绝"), kind: "reject_once" }] } })
      append("permission", snapshot.permissions[0]!)
      snapshot.inputs.push(input("3033", session.id, say("Include the empty state, too.", "也请处理空状态。"), "Sam", "pending"))
    }
    snapshot.session.lastEventSeq = String(journal.length)
    snapshots[session.id] = snapshot
    events[session.id] = journal
  }
  return { machine, snapshots, events }
}

export const demoPatch = "diff --git a/src/WorkspacePicker.vue b/src/WorkspacePicker.vue\n--- a/src/WorkspacePicker.vue\n+++ b/src/WorkspacePicker.vue\n@@ -1,5 +1,10 @@\n <template>\n-  <button @click=\"open = true\">\n+  <button\n+    :aria-expanded=\"open\"\n+    @click=\"open = true\"\n+    @keydown.down.prevent=\"open = true\"\n+    @keydown.esc=\"open = false\"\n+  >\n     Workspace\n   </button>\n </template>\n"
