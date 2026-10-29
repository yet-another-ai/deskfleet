import type { Meta, StoryObj } from "@storybook/vue3-vite"
import type { AgentEvent, AgentSnapshot } from "../../../../../apps/daemon/src/agent-protocol.ts"
import { storybookSessionEvents, storybookSessionSnapshot } from "../../../.storybook/storybook-fixtures.ts"
import AgentOutline from "./AgentOutline.vue"

const multiTurnSnapshot: AgentSnapshot = {
  ...storybookSessionSnapshot,
  inputs: [
    ...storybookSessionSnapshot.inputs,
    {
      id: "inp-2",
      sessionId: "sess-1",
      submissionCommandId: "cmd-2",
      author: { kind: "user", userId: "user-1" },
      content: [{ type: "text", text: "Add dark mode and Chinese locale switchers to the toolbar." }],
      acceptedSeq: "7",
      state: "delivered",
      requestedDelivery: "backlog",
      actualDelivery: "turn_start",
      createdAt: "2026-10-29T14:05:00Z",
    },
    {
      id: "inp-3",
      sessionId: "sess-1",
      submissionCommandId: "cmd-3",
      author: { kind: "user", userId: "user-2" },
      content: [{ type: "text", text: "Verify Git diff rendering and file tree expand/collapse states." }],
      acceptedSeq: "10",
      state: "delivered",
      requestedDelivery: "backlog",
      actualDelivery: "turn_start",
      createdAt: "2026-10-29T14:10:00Z",
    },
  ],
}

const multiTurnEvents: AgentEvent[] = [
  ...storybookSessionEvents,
  {
    sessionId: "sess-1",
    seq: "7",
    kind: "input",
    payload: multiTurnSnapshot.inputs[2]!,
    createdAt: "2026-10-29T14:05:00Z",
    runGeneration: 1,
    turnId: "turn-2",
  },
  {
    sessionId: "sess-1",
    seq: "8",
    kind: "acp",
    payload: {
      sessionId: "sess-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Added `theme` and `locale` global toolbar controls in `.storybook/preview.ts`.",
        },
      },
    },
    createdAt: "2026-10-29T14:05:30Z",
    runGeneration: 1,
    turnId: "turn-2",
  },
  {
    sessionId: "sess-1",
    seq: "10",
    kind: "input",
    payload: multiTurnSnapshot.inputs[3]!,
    createdAt: "2026-10-29T14:10:00Z",
    runGeneration: 1,
    turnId: "turn-3",
  },
  {
    sessionId: "sess-1",
    seq: "11",
    kind: "acp",
    payload: {
      sessionId: "sess-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Verified `GitDiffView`, `GitDiffCard`, and `GitChanges` stories with unified diff fixtures.",
        },
      },
    },
    createdAt: "2026-10-29T14:11:00Z",
    runGeneration: 1,
    turnId: "turn-3",
  },
]

const meta = {
  title: "Domain/Agent Session/AgentOutline",
  component: AgentOutline,
  tags: ["autodocs"],
  args: {
    events: multiTurnEvents,
    snapshot: multiTurnSnapshot,
    active: "input-inp-1",
  },
} satisfies Meta<typeof AgentOutline>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
