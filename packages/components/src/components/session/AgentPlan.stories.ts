import type { Meta, StoryObj } from "@storybook/vue3-vite"
import AgentPlan from "./AgentPlan.vue"

const meta = {
  title: "Domain/Agent Session/AgentPlan",
  component: AgentPlan,
  tags: ["autodocs"],
  args: {
    entries: [
      { content: "Configure Storybook 10 Vite builder and UnoCSS plugin", status: "completed" },
      { content: "Create stories for session and details components", status: "in_progress" },
      { content: "Run Storybook build verification", status: "pending" },
    ],
  },
} satisfies Meta<typeof AgentPlan>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
