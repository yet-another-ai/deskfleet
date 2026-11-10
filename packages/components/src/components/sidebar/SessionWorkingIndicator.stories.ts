import type { Meta, StoryObj } from "@storybook/vue3-vite"
import SessionWorkingIndicator from "./SessionWorkingIndicator.vue"

const meta = {
  title: "Foundational/Display & Badges/SessionWorkingIndicator",
  component: SessionWorkingIndicator,
  tags: ["autodocs"],
  render: args => ({
    components: { SessionWorkingIndicator },
    setup: () => ({ args }),
    template: `
      <div class="w-60 flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-ui-surface border border-ui-border text-sm">
        <span class="truncate">Add Storybook for UI components</span>
        <SessionWorkingIndicator v-bind="args" />
      </div>
    `,
  }),
} satisfies Meta<typeof SessionWorkingIndicator>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Permission: Story = { args: { state: "permission" } }
export const Question: Story = { args: { state: "question" } }
export const Archiving: Story = { args: { state: "archiving" } }
