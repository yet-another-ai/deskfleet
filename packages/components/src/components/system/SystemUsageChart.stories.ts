import type { Meta, StoryObj } from "@storybook/vue3-vite"
import SystemUsageChart from "./SystemUsageChart.vue"

const now = Date.now()

const steadySamples = Array.from({ length: 20 }, (_, index) => ({
  time: now - (19 - index) * 2_000,
  cpu: 24 + ((index * 9) % 35),
  memory: 58 + ((index * 3) % 12),
}))

const meta = {
  title: "Domain/Charts & Visualizations/SystemUsageChart",
  component: SystemUsageChart,
  tags: ["autodocs"],
  args: {
    samples: steadySamples,
    active: true,
  },
} satisfies Meta<typeof SystemUsageChart>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const EmptySamples: Story = {
  args: {
    samples: [],
  },
}
