import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { storybookPermission } from "../../../.storybook/storybook-fixtures.ts"
import AgentToolCall from "./AgentToolCall.vue"

const meta = {
  title: "Interactive & Collapsible/Collapsible Panels/AgentToolCall",
  component: AgentToolCall,
  tags: ["autodocs"],
  args: {
    live: false,
    tool: {
      toolCallId: "tc-read-1",
      title: "Read packages/components/src/components/common/UiButton.vue",
      kind: "read",
      status: "completed",
      locations: [{ path: "/workspace/deskfleet/packages/components/src/components/common/UiButton.vue", line: 1 }],
      rawOutput: { linesRead: 42 },
    },
  },
} satisfies Meta<typeof AgentToolCall>

export default meta
type Story = StoryObj<typeof meta>

export const CompletedRead: Story = {}

export const EditWithDiffContent: Story = {
  args: {
    live: false,
    tool: {
      toolCallId: "tc-edit-1",
      title: "Edit packages/components/src/components/common/UiButton.vue",
      kind: "edit",
      status: "completed",
      locations: [{ path: "/workspace/deskfleet/packages/components/src/components/common/UiButton.vue", line: 10 }],
      content: [
        {
          type: "diff",
          path: "packages/components/src/components/common/UiButton.vue",
          oldText: "  disabled?: boolean\n}",
          newText: "  disabled?: boolean\n  loading?: boolean\n}",
        },
      ],
    },
  },
}

export const AwaitingPermission: Story = {
  args: {
    live: true,
    permission: storybookPermission,
    tool: storybookPermission.request.toolCall,
  },
}

export const FailedToolCall: Story = {
  args: {
    live: false,
    tool: {
      toolCallId: "tc-fail-1",
      title: "Fetch https://internal.example/api/schema",
      kind: "fetch",
      status: "failed",
      rawInput: { url: "https://internal.example/api/schema" },
      rawOutput: "Error: connect ECONNREFUSED 127.0.0.1:8443",
    },
  },
}
