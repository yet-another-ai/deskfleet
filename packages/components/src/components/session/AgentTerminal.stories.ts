import type { Meta, StoryObj } from "@storybook/vue3-vite"
import AgentTerminal from "./AgentTerminal.vue"

const meta = {
  title: "Domain/Terminal/AgentTerminal",
  component: AgentTerminal,
  tags: ["autodocs"],
  args: {
    terminalId: "term-1",
  },
} satisfies Meta<typeof AgentTerminal>

export default meta
type Story = StoryObj<typeof meta>

export const RunningTerminal: Story = {}

export const ExitedTerminal: Story = {
  args: {
    terminalId: "term-2",
  },
}
