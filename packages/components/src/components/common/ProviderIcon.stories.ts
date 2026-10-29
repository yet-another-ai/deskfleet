import type { Meta, StoryObj } from "@storybook/vue3-vite"
import ProviderIcon from "./ProviderIcon.vue"

const meta = {
  title: "Foundational/Display & Badges/ProviderIcon",
  component: ProviderIcon,
  tags: ["autodocs"],
  argTypes: {
    icon: {
      control: "select",
      options: ["claude", "openai", "cursor", "grok", "gemini", "githubcopilot", ""],
    },
    template: {
      control: "select",
      options: ["claude-code", "codex", "cursor", "grok", "custom", ""],
    },
    size: {
      control: { type: "number", min: 12, max: 48, step: 2 },
    },
  },
  args: {
    icon: "claude",
    template: "claude-code",
    size: 20,
  },
} satisfies Meta<typeof ProviderIcon>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const AllProvidersShowcase: Story = {
  render: () => ({
    components: { ProviderIcon },
    template: `
      <div class="flex flex-wrap items-center gap-6">
        <div class="flex items-center gap-2">
          <ProviderIcon icon="claude" template="claude-code" :size="20" />
          <span class="text-sm">Claude Code</span>
        </div>
        <div class="flex items-center gap-2">
          <ProviderIcon icon="openai" template="codex" :size="20" />
          <span class="text-sm">Codex</span>
        </div>
        <div class="flex items-center gap-2">
          <ProviderIcon icon="cursor" template="cursor" :size="20" />
          <span class="text-sm">Cursor</span>
        </div>
        <div class="flex items-center gap-2">
          <ProviderIcon icon="grok" template="grok" :size="20" />
          <span class="text-sm">Grok</span>
        </div>
        <div class="flex items-center gap-2">
          <ProviderIcon :size="20" />
          <span class="text-sm">Custom / Fallback</span>
        </div>
      </div>
    `,
  }),
}
