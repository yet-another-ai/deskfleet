import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { DEFAULT_TERMINAL_FONT } from "@deskfleet/client/appearance"
import AppearanceTerminalPreview from "./AppearanceTerminalPreview.vue"

const meta = {
  title: "Domain/Terminal/AppearanceTerminalPreview",
  component: AppearanceTerminalPreview,
  tags: ["autodocs"],
  args: {
    fontFamily: DEFAULT_TERMINAL_FONT,
    ligatures: true,
  },
} satisfies Meta<typeof AppearanceTerminalPreview>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
