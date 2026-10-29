import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { Plus, Trash2, Sparkles } from "@lucide/vue"
import UiButton from "./UiButton.vue"

const meta = {
  title: "Foundational/Inputs & Actions/UiButton",
  component: UiButton,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "primary", "danger", "ghost"],
    },
    size: {
      control: "select",
      options: ["default", "sm", "icon"],
    },
    type: {
      control: "select",
      options: ["button", "submit", "reset"],
    },
    disabled: { control: "boolean" },
    loading: { control: "boolean" },
  },
  args: {
    variant: "default",
    size: "default",
    type: "button",
    disabled: false,
    loading: false,
  },
  render: (args) => ({
    components: { UiButton },
    setup: () => ({ args }),
    template: `<UiButton v-bind="args">Button Label</UiButton>`,
  }),
} satisfies Meta<typeof UiButton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const AllVariantsShowcase: Story = {
  render: () => ({
    components: { UiButton, Plus, Trash2, Sparkles },
    template: `
      <div class="flex flex-col gap-4">
        <div class="flex flex-wrap items-center gap-3">
          <UiButton variant="default">Default</UiButton>
          <UiButton variant="primary"><Sparkles :size="14" /> Primary</UiButton>
          <UiButton variant="danger"><Trash2 :size="14" /> Danger</UiButton>
          <UiButton variant="ghost">Ghost</UiButton>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <UiButton size="sm" variant="default">Small Default</UiButton>
          <UiButton size="sm" variant="primary">Small Primary</UiButton>
          <UiButton size="icon" variant="default" aria-label="Add"><Plus :size="15" /></UiButton>
          <UiButton variant="primary" loading>Loading</UiButton>
          <UiButton variant="default" disabled>Disabled</UiButton>
        </div>
      </div>
    `,
  }),
}
