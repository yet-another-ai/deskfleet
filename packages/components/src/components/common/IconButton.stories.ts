import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { Copy, PanelLeft, Plus, Settings, Trash2 } from "@lucide/vue"
import IconButton from "./IconButton.vue"

const meta = {
  title: "Foundational/Inputs & Actions/IconButton",
  component: IconButton,
  tags: ["autodocs"],
  argTypes: {
    label: { control: "text" },
    placeholder: { control: "boolean" },
    disabled: { control: "boolean" },
  },
  args: {
    icon: Settings,
    label: "Open settings",
    placeholder: false,
    disabled: false,
  },
} satisfies Meta<typeof IconButton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const ToolbarCluster: Story = {
  render: () => ({
    components: { IconButton },
    setup: () => ({ PanelLeft, Plus, Copy, Settings, Trash2 }),
    template: `
      <div class="inline-flex items-center gap-1 rounded-lg border border-ui-border bg-ui-surface p-1">
        <IconButton :icon="PanelLeft" label="Toggle sidebar" />
        <IconButton :icon="Plus" label="New session" />
        <IconButton :icon="Copy" label="Copy link" />
        <IconButton :icon="Settings" label="Settings" placeholder />
        <IconButton :icon="Trash2" label="Delete" disabled />
      </div>
    `,
  }),
}
