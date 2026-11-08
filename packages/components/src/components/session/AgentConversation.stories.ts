import type { Meta, StoryObj } from "@storybook/vue3-vite"
import type { SessionUpdate } from "@agentclientprotocol/sdk/unstable"
import { ref } from "vue"
import { storybookElicitation, storybookSessionEvents, storybookSessionSnapshot } from "../../../.storybook/storybook-fixtures.ts"
import { useFleetStore } from "../../stores/fleet.ts"
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

const protocolEvent = (seq: number, update: SessionUpdate, sessionId = "provider-1") => ({
  sessionId: "sess-1", seq: String(seq), kind: "acp" as const, payload: { sessionId, update },
  createdAt: "2026-10-29T14:01:12Z", runGeneration: 1, turnId: "turn-1",
})

export const ProtocolExtensions: Story = {
  args: {
    notices: [
      { id: "notice-1", severity: "warning", title: "Approaching the context limit", description: "The agent will compact the conversation before continuing." },
    ],
    snapshot: { ...storybookSessionSnapshot, permissions: [], elicitations: [] },
    events: [
      protocolEvent(1, { sessionUpdate: "plan_update", plan: { type: "items", planId: "implementation", entries: [
        { content: "Inspect provider capabilities", status: "completed", priority: "high" },
        { content: "Render plans, compaction and child sessions", status: "in_progress", priority: "high" },
        { content: "Verify reconnect and replay", status: "pending", priority: "medium" },
      ] } }),
      protocolEvent(2, { sessionUpdate: "subagent_update", sessionId: "reviewer", title: "Protocol reviewer", description: "Check the implementation against ACP session semantics", state: { state: "running" } }),
      protocolEvent(3, { sessionUpdate: "session_message", messageId: "assignment", senderSessionId: "provider-1", recipientSessionId: "reviewer", content: [{ type: "text", text: "Review plan replacement, removal, and context compaction replay." }] }, "reviewer"),
      protocolEvent(4, { sessionUpdate: "tool_call", toolCallId: "read", title: "Read conversation-projector.ts", kind: "read", status: "completed" }, "reviewer"),
      protocolEvent(5, { sessionUpdate: "agent_message_chunk", messageId: "review", content: { type: "text", text: "The projection preserves the first event position and isolates reused IDs between sessions." } }, "reviewer"),
      protocolEvent(6, { sessionUpdate: "compaction_update", compactionId: "compaction-1", status: "completed", summary: [{ type: "text", text: "Retained the capability audit, implementation decisions, and pending verification steps." }] }),
      protocolEvent(7, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The new protocol events now have dedicated views. I am finishing the verification." } }),
    ],
  },
}

export const MessageSentTransition: Story = {
  args: CompletedTurn.args,
  render: (args) => ({
    components: { AgentConversation, SessionComposer },
    setup() {
      const fleet = useFleetStore()
      const events = ref([...(args.events ?? [])])
      const draft = ref("Verify the post-send spring transition.")
      function send() {
        const text = draft.value.trim()
        if (!text) return
        const seq = String(events.value.length + 2)
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
      return { args, events, draft, fleet, send }
    },
    template: `
      <div class="mx-auto flex max-w-3xl flex-col gap-6 pt-8">
        <div class="h-56 overflow-y-auto px-2" data-session-scroll-viewport>
          <AgentConversation v-bind="args" :events="events" />
        </div>
        <SessionComposer v-model="draft" :location="fleet.newSessionTarget" :show-target="false" @submit="send" />
      </div>
    `,
  }),
}

