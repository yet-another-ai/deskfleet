import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { storybookElicitation, storybookSessionEvents, storybookSessionSnapshot } from "../../../.storybook/storybook-fixtures.ts"
import AgentConversation from "./AgentConversation.vue"

const meta = {
  title: "Domain/Agent Session/AgentConversation",
  component: AgentConversation,
  tags: ["autodocs"],
  args: {
    events: storybookSessionEvents,
    snapshot: storybookSessionSnapshot,
    disabled: false,
    resourceTarget: {
      kind: "machine",
      machineId: "machine-1",
      teamId: "team-1",
    },
  },
} satisfies Meta<typeof AgentConversation>

export default meta
type Story = StoryObj<typeof meta>

export const RunningTurn: Story = {}

export const CompletedTurn: Story = {
  args: {
    events: [
      ...storybookSessionEvents.slice(0, 5),
      {
        sessionId: "sess-1",
        seq: "6",
        kind: "turn",
        payload: {
          ...storybookSessionSnapshot.turns[0]!,
          state: "completed",
          endedAt: "2026-10-29T14:01:12Z",
        },
        createdAt: "2026-10-29T14:01:12Z",
        runGeneration: 1,
        turnId: "turn-1",
      },
    ],
    snapshot: {
      ...storybookSessionSnapshot,
      turns: [
        {
          ...storybookSessionSnapshot.turns[0]!,
          state: "completed",
          endedAt: "2026-10-29T14:01:12Z",
        },
      ],
      permissions: [],
      elicitations: [],
    },
  },
}

export const AwaitingElicitation: Story = {
  args: {
    events: [
      ...storybookSessionEvents.slice(0, 4),
      {
        sessionId: "sess-1",
        seq: "5",
        kind: "elicitation",
        payload: storybookElicitation,
        createdAt: "2026-10-29T14:21:00Z",
        runGeneration: 1,
        turnId: "turn-1",
      },
    ],
    snapshot: {
      ...storybookSessionSnapshot,
      permissions: [],
      elicitations: [storybookElicitation],
    },
  },
}
