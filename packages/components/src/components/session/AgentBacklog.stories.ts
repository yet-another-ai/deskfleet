import type { Meta, StoryObj } from "@storybook/vue3-vite"
import type { AgentInput } from "../../../../../apps/daemon/src/agent-protocol.ts"
import AgentBacklog from "./AgentBacklog.vue"

const pendingInputs: AgentInput[] = [
  {
    id: "inp-pending-1",
    sessionId: "sess-1",
    submissionCommandId: "cmd-10",
    author: { kind: "user", userId: "user-1" },
    content: [{ type: "text", text: "Add dark mode and Chinese locale switchers to the Storybook toolbar." }],
    acceptedSeq: "10",
    state: "pending",
    requestedDelivery: "backlog",
    createdAt: "2026-10-29T14:23:00Z",
  },
  {
    id: "inp-pending-2",
    sessionId: "sess-1",
    submissionCommandId: "cmd-11",
    author: { kind: "user", userId: "user-2" },
    content: [{ type: "text", text: "/compact" }],
    acceptedSeq: "11",
    state: "pending",
    requestedDelivery: "backlog",
    createdAt: "2026-10-29T14:24:00Z",
  },
]

const meta = {
  title: "Domain/Agent Session/AgentBacklog",
  component: AgentBacklog,
  tags: ["autodocs"],
  args: {
    inputs: pendingInputs,
    canSteer: true,
    disabled: false,
  },
} satisfies Meta<typeof AgentBacklog>

export default meta
type Story = StoryObj<typeof meta>

export const PendingQueue: Story = {}

export const WithFailedInput: Story = {
  args: {
    inputs: [
      ...pendingInputs,
      {
        id: "inp-failed-1",
        sessionId: "sess-1",
        submissionCommandId: "cmd-12",
        author: { kind: "user", userId: "user-1" },
        content: [{ type: "text", text: "Run the visual regression suite across all viewports." }],
        acceptedSeq: "12",
        state: "failed",
        requestedDelivery: "backlog",
        createdAt: "2026-10-29T14:25:00Z",
        error: "Provider session disconnected while dispatching prompt.",
      },
    ],
  },
}
