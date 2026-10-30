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

export const ConsecutiveActivity: Story = {
  args: {
    response: {
      ...completedResponse,
      id: "resp-activity",
      live: true,
      startedAt: new Date().toISOString(),
      endedAt: undefined,
      turn: { ...completedResponse.turn!, state: "running", endedAt: undefined },
      steps: [
        { id: "intro", kind: "message", role: "assistant", content: [{ type: "text", text: "I'll check the Session view and its existing tests." }] },
        ...completedResponse.steps.slice(0, 2),
        { id: "search", kind: "tool", tool: { toolCallId: "search", title: "Find tool call and thought renderers", kind: "search", status: "completed", rawInput: "rg AgentToolCall packages/components/src" } },
        { id: "thought-2", kind: "message", role: "thought", content: [{ type: "text", text: "Consecutive activity can share one disclosure while messages stay visible." }] },
        { id: "progress", kind: "message", role: "assistant", content: [{ type: "text", text: "The grouping is in place. I'm checking streaming updates and keyboard interaction." }] },
        { id: "test-plan", kind: "message", role: "thought", content: [{ type: "text", text: "Verify that expanding a group survives new tool events." }] },
        { id: "test", kind: "tool", tool: { toolCallId: "test", title: "Run Session component tests", kind: "execute", status: "in_progress", rawInput: "pnpm test" } },
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
