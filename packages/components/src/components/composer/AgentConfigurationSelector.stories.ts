import type { Meta, StoryObj } from "@storybook/vue3-vite"
import AgentConfigurationSelector from "./AgentConfigurationSelector.vue"

const meta = {
  title: "Interactive & Collapsible/Pickers & Menus/AgentConfigurationSelector",
  component: AgentConfigurationSelector,
  tags: ["autodocs"],
  args: {
    workspaceId: "ws-1",
    providerId: "claude-code",
    disabled: false,
  },
} satisfies Meta<typeof AgentConfigurationSelector>

export default meta
type Story = StoryObj<typeof meta>

export const NewSessionDraft: Story = {
  args: {
    workspaceId: "ws-1",
    providerId: "claude-code",
  },
}

export const ExistingSessionLockedProvider: Story = {
  args: {
    workspaceId: "ws-1",
    sessionId: "sess-1",
  },
}

export const Disabled: Story = {
  args: {
    workspaceId: "ws-1",
    providerId: "claude-code",
    disabled: true,
  },
}
