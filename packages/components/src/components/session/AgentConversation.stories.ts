import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { ref } from "vue"
import { storybookElicitation, storybookSessionEvents, storybookSessionSnapshot } from "../../../.storybook/storybook-fixtures.ts"
import SessionComposer from "../composer/SessionComposer.vue"
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
    canFork: true,
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

export const MessageSentTransition: Story = {
  args: CompletedTurn.args,
  render: (args) => ({
    components: { AgentConversation, SessionComposer },
    setup() {
      const events = ref([...(args.events ?? [])])
      const draft = ref("Verify the post-send spring transition.")
      function send() {
        const text = draft.value.trim()
        if (!text) return
        const seq = String(events.value.length + 1)
        const createdAt = new Date().toISOString()
        draft.value = ""
        events.value = [
          ...events.value,
          {
            sessionId: "sess-1",
            seq,
            kind: "input",
            payload: {
              id: `inp-${seq}`,
              sessionId: "sess-1",
              submissionCommandId: `cmd-${seq}`,
              author: { kind: "user", userId: "Ada Lovelace" },
              content: [{ type: "text", text }],
              acceptedSeq: seq,
              state: "delivered",
              requestedDelivery: "backlog",
              actualDelivery: "turn_start",
              createdAt,
            },
            createdAt,
            runGeneration: 1,
          },
        ]
      }
      return { args, events, draft, send }
    },
    template: `
      <div class="mx-auto flex max-w-3xl flex-col gap-6">
        <AgentConversation v-bind="args" :events="events" />
        <SessionComposer v-model="draft" :show-target="false" @submit="send" />
      </div>
    `,
  }),
}

