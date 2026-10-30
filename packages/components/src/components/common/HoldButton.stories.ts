import type { Meta, StoryObj } from "@storybook/vue3-vite"
import HoldButton from "./HoldButton.vue"

const meta = {
  title: "Foundational/Inputs & Actions/HoldButton",
  component: HoldButton,
  tags: ["autodocs"],
  args: {
    text: "Delete session",
    holdLabel: "Hold to confirm",
    variant: "danger",
    holdDurationMs: 1200,
    disabled: false,
  },
} satisfies Meta<typeof HoldButton>

export default meta
type Story = StoryObj<typeof meta>

export const Danger: Story = {}

export const Default: Story = {
  args: {
    text: "Reset workspace",
    variant: "default",
  },
}
