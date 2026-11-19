import type { Meta, StoryObj } from "@storybook/vue3-vite"
import AgentConfigurationSelector from "./AgentConfigurationSelector.vue"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useProvidersStore } from "../../stores/providers.ts"
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

export const AntigravityPeriodicTable: Story = {
  args: { workspaceId: "ws-1", sessionId: "sess-agy" },
  render: args => ({
    components: { AgentConfigurationSelector },
    setup() {
      const providers = useProvidersStore()
      if (!providers.providers.some(provider => provider.id === "antigravity")) {
        providers.providers = [...providers.providers, { id: "antigravity", name: "Antigravity", template: "antigravity" }]
      }
      const agents = useAgentSessionsStore()
      agents.configurations["sess-agy"] = {
        provider: { id: "antigravity", name: "Antigravity" },
        models: {
          id: "model",
          currentValue: "gemini-4-neon",
          options: [
            { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", description: "Fast, lightweight everyday workhorse for rapid code edits and high-throughput agentic workflows." },
            { id: "gemini-4-carbon", name: "Gemini 4 Carbon", description: "Deepest frontier reasoning flagship built for the hardest multi-step architecture and research tasks." },
            { id: "gemini-4-neon", name: "Gemini 4 Neon", description: "Balanced reasoning and agentic coding model for multi-file refactoring and daily knowledge work." },
            { id: "gemini-4-argon", name: "Gemini 4 Argon", description: "A highly capable model, built to solve complex problems with depth and precision across real-world software engineering and knowledge work." },
          ],
        },
        reasoningEfforts: { id: "effort", currentValue: "high", options: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }, { id: "high", name: "High" }] },
        modes: null,
      }
      agents.configureSession = async (id, selection) => {
        const current = agents.configurations[id]!
        agents.configurations[id] = {
          ...current,
          models: current.models ? { ...current.models, currentValue: selection.model ?? current.models.currentValue } : null,
        }
        return agents.configurations[id]!
      }
      return { args }
    },
    template: '<div class="flex min-h-96 items-end p-6"><AgentConfigurationSelector v-bind="args" /></div>',
  }),
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>("[data-gemini-periodic-table-trigger]")?.click()
  },
}
