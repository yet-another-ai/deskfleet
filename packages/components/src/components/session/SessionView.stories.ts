import type { AgentActor, AgentInput, AgentSnapshot } from "@deskfleet/protocol/agent"
import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { onUnmounted } from "vue"
import { storybookSessionSnapshot } from "../../../.storybook/storybook-fixtures.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import SessionView from "../../views/SessionView.vue"

const sessionId = "story-release-notes"
const person: AgentActor = { kind: "user", userId: "user-1" }
const agent: AgentActor = { ...person, via: "mcp" }
const superAgent: AgentActor = { ...person, via: "super_agent_mcp" }

function input(seq: number, author: AgentActor, text: string, state: "delivered" | "pending" = "delivered"): AgentInput {
  return {
    id: `input-${seq}`, sessionId, submissionCommandId: `cmd-${seq}`, acceptedSeq: String(seq),
    author, content: [{ type: "text", text }], state, requestedDelivery: "backlog",
    createdAt: `2026-10-29T14:0${seq}:00Z`,
  }
}

const meta = {
  title: "Views/SessionView",
  component: SessionView,
  args: { sessionId },
  parameters: { layout: "fullscreen" },
  globals: { backgrounds: { grid: false } },
} satisfies Meta<typeof SessionView>
export default meta
type Story = StoryObj<typeof meta>

export const McpAttribution: Story = {
  render: () => ({
    components: { SessionView },
    setup() {
      const agents = useAgentSessionsStore()
      const snapshot: AgentSnapshot = {
        session: { ...storybookSessionSnapshot.session, id: sessionId, context: "directory", title: "Release notes", lastEventSeq: "4", createdBy: superAgent },
        inputs: [
          input(1, agent, "List the changes since the last release."),
          input(2, superAgent, "Group the changes by feature."),
          input(3, person, "Lead with the new session controls."),
          input(4, superAgent, "Draft a short upgrade note.", "pending"),
        ],
        runs: [], turns: [], permissions: [], elicitations: [],
      }
      const events = snapshot.inputs.map(payload => ({
        sessionId, seq: payload.acceptedSeq, kind: "input" as const, payload, createdAt: payload.createdAt,
      }))
      agents.sessions[sessionId] = snapshot.session
      agents.views[sessionId] = { snapshot, events, loading: false, error: null, historySeq: "4", snapshotSeq: "4" }
      // The preview owns its Session and never joins a live channel.
      const { attend, leave } = agents
      agents.attend = id => id === sessionId ? Promise.resolve(true) : attend(id)
      agents.leave = id => id === sessionId ? Promise.resolve() : leave(id)
      onUnmounted(() => {
        Object.assign(agents, { attend, leave })
        delete agents.views[sessionId]
        delete agents.sessions[sessionId]
        delete agents.drafts[sessionId]
      })
      return { sessionId }
    },
    template: '<div class="mx-auto flex h-[calc(100dvh-2rem)] min-h-0 max-w-4xl flex-col overflow-hidden rounded-xl border border-ui-border bg-ui-canvas"><SessionView :session-id="sessionId" /></div>',
  }),
}
