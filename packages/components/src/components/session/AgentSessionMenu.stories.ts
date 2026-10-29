import type { Meta, StoryObj } from "@storybook/vue3-vite"
import AgentSessionMenu from "./AgentSessionMenu.vue"

const meta = {
  title: "Interactive & Collapsible/Pickers & Menus/AgentSessionMenu",
  component: AgentSessionMenu,
  tags: ["autodocs"],
  args: {
    canStop: true,
    canFork: true,
    forkDisabled: false,
    disabled: false,
    archiveState: "active",
  },
} satisfies Meta<typeof AgentSessionMenu>

export default meta
type Story = StoryObj<typeof meta>

export const ActiveSession: Story = {}

export const ArchivedSession: Story = {
  args: {
    canStop: false,
    canFork: false,
    archiveState: "archived",
  },
}
