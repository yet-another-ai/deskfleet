import type { Meta, StoryObj } from "@storybook/vue3-vite"
import ProviderIconPicker from "./ProviderIconPicker.vue"

const meta = {
  title: "Interactive & Collapsible/Pickers & Menus/ProviderIconPicker",
  component: ProviderIconPicker,
  tags: ["autodocs"],
  args: {
    template: "claude-code",
    modelValue: undefined,
    disabled: false,
  },
} satisfies Meta<typeof ProviderIconPicker>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Disabled: Story = {
  args: {
    template: "codex",
    modelValue: "openai",
    disabled: true,
  },
}
