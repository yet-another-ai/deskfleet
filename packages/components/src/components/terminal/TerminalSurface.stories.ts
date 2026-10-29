import type { Meta, StoryObj } from "@storybook/vue3-vite"
import TerminalSurface from "./TerminalSurface.vue"

const ansiBanner = [
  "\x1b[1;34mDeskFleet Terminal Surface\x1b[0m",
  "\x1b[32m✓\x1b[0m Built @deskfleet/components in 412ms",
  "\x1b[33m!\x1b[0m Watching packages/components/src for changes...",
  "",
  "ada@studio-macbook deskfleet % ",
].join("\n")

const meta = {
  title: "Domain/Terminal/TerminalSurface",
  component: TerminalSurface,
  tags: ["autodocs"],
  args: {
    banner: ansiBanner,
    interactive: true,
    scrollback: 5_000,
  },
  render: (args) => ({
    components: { TerminalSurface },
    setup() {
      return { args }
    },
    template: `
      <div class="h-72 overflow-hidden rounded-lg border border-ui-border bg-ui-terminal p-2">
        <TerminalSurface v-bind="args" />
      </div>
    `,
  }),
} satisfies Meta<typeof TerminalSurface>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
