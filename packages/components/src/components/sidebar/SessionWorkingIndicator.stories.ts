import type { Meta, StoryObj } from "@storybook/vue3-vite"
import SessionWorkingIndicator from "./SessionWorkingIndicator.vue"

const meta = {
  title: "Foundational/Display & Badges/SessionWorkingIndicator",
  component: SessionWorkingIndicator,
  tags: ["autodocs"],
  render: () => ({
    components: { SessionWorkingIndicator },
    template: `
      <div class="w-60 flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-ui-surface border border-ui-border text-sm">
        <span class="truncate">Add Storybook for UI components</span>
        <SessionWorkingIndicator />
      </div>
    `,
  }),
} satisfies Meta<typeof SessionWorkingIndicator>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
