import type { Meta, StoryObj } from "@storybook/vue3-vite"
import WorktreeSettings from "./WorktreeSettings.vue"

const meta = {
  title: "Features/Settings/WorktreeSettings",
  component: WorktreeSettings,
  globals: { backgrounds: { grid: false } },
  render: () => ({
    components: { WorktreeSettings },
    template: '<div class="mx-auto max-w-3xl"><WorktreeSettings /></div>',
  }),
} satisfies Meta<typeof WorktreeSettings>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
