import type { Meta, StoryObj } from "@storybook/vue3-vite"
import ScheduleRunDot from "./ScheduleRunDot.vue"

const meta = {
  title: "Foundational/Display & Badges/ScheduleRunDot",
  component: ScheduleRunDot,
  tags: ["autodocs"],
  args: {
    state: "completed",
  },
  render: (args) => ({
    components: { ScheduleRunDot },
    setup() {
      return { args }
    },
    template: `
      <div class="inline-flex items-center gap-2 text-sm">
        <ScheduleRunDot v-bind="args" class="h-2.5 w-2.5" />
        <span>{{ args.state }}</span>
      </div>
    `,
  }),
} satisfies Meta<typeof ScheduleRunDot>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const AllStatesComparison: Story = {
  render: () => ({
    components: { ScheduleRunDot },
    setup() {
      const states = ["claimed", "running", "completed", "failed", "interrupted", "skipped"] as const
      return { states }
    },
    template: `
      <div class="flex flex-wrap items-center gap-4 text-sm">
        <div v-for="state in states" :key="state" class="flex items-center gap-2">
          <ScheduleRunDot :state="state" class="h-2.5 w-2.5" />
          <span>{{ state }}</span>
        </div>
      </div>
    `,
  }),
}
