import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { DEFAULT_TERMINAL_FONT } from "@deskfleet/client/appearance"
import { resolveTerminalTheme } from "@deskfleet/client/terminal-theme"
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
export const SolarizedLight: Story = { args: { theme: resolveTerminalTheme("solarized-light", {}) } }
export const Dracula: Story = { args: { theme: resolveTerminalTheme("dracula", {}) } }
