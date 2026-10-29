import type { Meta, StoryObj } from "@storybook/vue3-vite"
import type { ConversationResponse } from "../../services/agent-conversation.ts"
import { storybookPermission } from "../../../.storybook/storybook-fixtures.ts"
import AgentResponse from "./AgentResponse.vue"

const completedResponse: ConversationResponse = {
  id: "resp-1",
  kind: "response",
  turnId: "turn-1",
  startedAt: "2026-10-29T14:00:06Z",
  endedAt: "2026-10-29T14:00:48Z",
  live: false,
  last: true,
  turn: {
    id: "turn-1",
    sessionId: "sess-1",
    initialInputId: "inp-1",
    dispatchCommandId: "cmd-1",
    runGeneration: 1,
    state: "completed",
    startedAt: "2026-10-29T14:00:06Z",
    endedAt: "2026-10-29T14:00:48Z",
  },
  steps: [
    {
      id: "step-thought-1",
      kind: "message",
      role: "thought",
      turnId: "turn-1",
      content: [{ type: "text", text: "Checking existing component props and Pinia store dependencies." }],
    },
    {
      id: "step-tool-1",
      kind: "tool",
      turnId: "turn-1",
      tool: {
        toolCallId: "tc-read-1",
        title: "Read packages/components/uno.config.ts",
        kind: "read",
        status: "completed",
        locations: [{ path: "/workspace/deskfleet/packages/components/uno.config.ts", line: 1 }],
      },
    },
    {
      id: "step-plan-1",
      kind: "plan",
      turnId: "turn-1",
      entries: [
        { content: "Inspect UnoCSS config and theme tokens", status: "completed" },
        { content: "Generate CSF3 story files", status: "completed" },
      ],
    },
    {
      id: "step-answer-1",
      kind: "message",
      role: "assistant",
      turnId: "turn-1",
      content: [
        {
          type: "text",
          text: "I have inspected the component hierarchy and generated CSF3 stories for the Session and Details categories.",
        },
      ],
    },
  ],
}

const meta = {
  title: "Interactive & Collapsible/Collapsible Panels/AgentResponse",
  component: AgentResponse,
  tags: ["autodocs"],
  args: {
    response: completedResponse,
    disabled: false,
  },
} satisfies Meta<typeof AgentResponse>

export default meta
type Story = StoryObj<typeof meta>

export const CompletedWithFoldedWork: Story = {}

export const LiveWorkingTurn: Story = {
  args: {
    response: {
      ...completedResponse,
      id: "resp-live",
      live: true,
      endedAt: undefined,
      turn: {
        ...completedResponse.turn!,
        state: "running",
        endedAt: undefined,
      },
      steps: [
        ...completedResponse.steps.slice(0, 2),
        {
          id: "step-tool-live",
          kind: "tool",
          turnId: "turn-1",
          permission: storybookPermission,
          tool: storybookPermission.request.toolCall,
        },
      ],
    },
  },
}

export const FailedTurn: Story = {
  args: {
    response: {
      ...completedResponse,
      id: "resp-failed",
      live: false,
      last: true,
      turn: {
        ...completedResponse.turn!,
        state: "failed",
        error: "Rate limit exceeded for model claude-sonnet-4-5",
      },
      steps: completedResponse.steps.slice(0, 2),
    },
  },
}
