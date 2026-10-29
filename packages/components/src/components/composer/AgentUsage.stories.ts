import type { Meta, StoryObj } from "@storybook/vue3-vite"
import AgentUsage from "./AgentUsage.vue"

const meta = {
  title: "Domain/Charts & Visualizations/AgentUsage",
  component: AgentUsage,
  tags: ["autodocs"],
  args: {
    usage: {
      sessionUpdate: "usage_update",
      used: 48_000,
      size: 200_000,
      cost: {
        amount: 0.1425,
        currency: "USD",
      },
    },
  },
} satisfies Meta<typeof AgentUsage>

export default meta
type Story = StoryObj<typeof meta>

export const NormalUsage: Story = {}

export const HighWarningUsage: Story = {
  args: {
    usage: {
      sessionUpdate: "usage_update",
      used: 188_500,
      size: 200_000,
      cost: {
        amount: 1.92,
        currency: "USD",
      },
    },
  },
}
