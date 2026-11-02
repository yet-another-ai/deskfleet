import type { Meta, StoryObj } from "@storybook/vue3-vite"
import DeveloperSettings from "./DeveloperSettings.vue"

const meta = {
  title: "Features/Settings/DeveloperSettings",
  component: DeveloperSettings,
  render: () => ({
    components: { DeveloperSettings },
    template: '<div class="mx-auto max-w-3xl"><DeveloperSettings /></div>',
  }),
} satisfies Meta<typeof DeveloperSettings>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
