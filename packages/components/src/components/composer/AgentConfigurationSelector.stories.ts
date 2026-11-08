import type { Meta, StoryObj } from "@storybook/vue3-vite"
import AgentConfigurationSelector from "./AgentConfigurationSelector.vue"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { makeConfiguration } from "../../../.storybook/storybook-fixtures.ts"

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

export const ProviderOptions: Story = {
  args: { workspaceId: "ws-1", sessionId: "sess-1" },
  render: args => ({
    components: { AgentConfigurationSelector },
    setup() {
      const agents = useAgentSessionsStore()
      agents.configurations["sess-1"] = { ...makeConfiguration("claude-code"), configOptions: [
        { id: "fast", name: "Fast mode", description: "Use faster inference for supported models.", category: "model_config", type: "boolean", currentValue: true },
        { id: "ultracode", name: "Ultracode", description: "Spend more time on complex coding tasks.", type: "boolean", currentValue: false },
        { id: "agent", name: "Agent profile", type: "select", currentValue: "default", options: [
          { group: "built-in", name: "Built-in profiles", options: [{ value: "default", name: "Default" }, { value: "review", name: "Code reviewer", description: "Review changes before continuing." }] },
          { group: "workspace", name: "Workspace profiles", options: [{ value: "release", name: "Release engineer" }] },
        ] },
      ] }
      agents.configureSession = async (id, selection) => {
        const current = agents.configurations[id]!
        agents.configurations[id] = { ...current, configOptions: current.configOptions?.map(option => ({ ...option,
          currentValue: selection.configValues?.[option.id] ?? option.currentValue,
        }) as typeof option) }
        return agents.configurations[id]!
      }
      return { args }
    },
    template: '<div class="flex min-h-96 items-end p-6"><AgentConfigurationSelector v-bind="args" /></div>',
  }),
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>("[data-agent-configuration-trigger]")?.click()
  },
}
