import type { Meta, StoryObj } from "@storybook/vue3-vite"
import AgentProtocolActivity from "./AgentProtocolActivity.vue"

const meta = {
  title: "Domain/Agent Session/AgentProtocolActivity",
  component: AgentProtocolActivity,
  tags: ["autodocs"],
  args: {
    live: true,
    step: { id: "compact", kind: "compaction", compaction: { compactionId: "compact-1", status: "in_progress", summary: [{ type: "text", text: "Keeping the implementation decisions and unfinished checks." }] } },
  },
} satisfies Meta<typeof AgentProtocolActivity>

export default meta
type Story = StoryObj<typeof meta>

export const CompactionRunning: Story = {}
export const CompactionCompleted: Story = {
  args: { live: false, locateEntry: "compact", step: { id: "compact", kind: "compaction", compaction: { compactionId: "compact-1", status: "completed", summary: [{ type: "text", text: "**Context retained**\n\n- Keep the existing machine registration boundary.\n- Implement the remaining protocol cards.\n- Run the focused component tests." }] } } },
}
export const CompactionFailed: Story = {
  args: { live: false, step: { id: "compact", kind: "compaction", compaction: { compactionId: "compact-1", status: "failed", error: "The provider could not compact the context. Try again after the current request finishes." } } },
}
export const StructuredPlanMarkdown: Story = {
  args: { step: { id: "plan", kind: "structured_plan", plan: { type: "markdown", planId: "implementation", content: "## Implement session extensions\n\n1. Preserve provider session IDs.\n2. Render plans and child sessions.\n3. Verify replay and reconnection." } } },
}
export const StructuredPlanFile: Story = {
  args: { step: { id: "plan-file", kind: "structured_plan", plan: { type: "file", planId: "implementation", uri: "file:///workspace/deskfleet/PLAN.md" } } },
}
export const ChildSession: Story = {
  args: {
    sessionLabels: { parent: "Implementation", child: "Protocol review" },
    step: { id: "child", kind: "subagent", session: { sessionId: "child", title: "Protocol review", description: "Check event ordering and session isolation", state: { state: "running" } }, steps: [
      { id: "task", kind: "session_message", message: { messageId: "request-1", senderSessionId: "parent", recipientSessionId: "child", content: [{ type: "text", text: "Review the session projection changes and report any ordering problems." }] } },
      { id: "tool", kind: "tool", tool: { toolCallId: "read", title: "Read conversation-projector.ts", kind: "read", status: "completed" } },
      { id: "answer", kind: "message", role: "assistant", content: [{ type: "text", text: "Child messages now stay in their own transcript. I am checking plan removal during replay." }] },
    ] },
  },
}
