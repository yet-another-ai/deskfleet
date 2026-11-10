import type { Meta, StoryObj } from "@storybook/vue3-vite"
import AgentOutline from "./AgentOutline.vue"

const meta = {
  title: "Domain/Agent Session/AgentOutline",
  component: AgentOutline,
  tags: ["autodocs"],
  argTypes: {
    preview: { control: "boolean" },
    rgb: { control: "boolean" },
    maxWidth: { control: { type: "number", min: 6 } },
    decayMs: { control: { type: "number", min: 0 } },
    active: { control: "text" },
  },
  args: {
    preview: false,
    rgb: false,
    maxWidth: 48,
    decayMs: 140,
  },
} satisfies Meta<typeof AgentOutline>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
