import type { Meta, StoryObj } from "@storybook/vue3-vite"
import UiButton from "./UiButton.vue"
import UiTooltip from "./UiTooltip.vue"

const meta = {
  title: "Foundational/Dialogs & Overlays/UiTooltip",
  component: UiTooltip,
  tags: ["autodocs"],
  argTypes: {
    text: { control: "text" },
  },
  args: {
    text: "Runs in an isolated Git worktree branch",
  },
  render: (args) => ({
    components: { UiTooltip, UiButton },
    setup: () => ({ args }),
    template: `
      <div class="p-8 flex items-center justify-center">
        <UiTooltip v-bind="args">
          <UiButton variant="default">Hover or focus me</UiButton>
        </UiTooltip>
      </div>
    `,
  }),
} satisfies Meta<typeof UiTooltip>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
