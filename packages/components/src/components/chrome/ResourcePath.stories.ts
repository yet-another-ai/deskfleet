import type { Meta, StoryObj } from "@storybook/vue3-vite"
import ResourcePath from "./ResourcePath.vue"

const meta = {
  title: "Foundational/Layout & Chrome/ResourcePath",
  component: ResourcePath,
  tags: ["autodocs"],
  argTypes: {
    segments: { control: "object" },
  },
  args: {
    segments: ["MacBook Pro (Studio)", "deskfleet-monorepo", "feat/storybook"],
  },
  render: (args) => ({
    components: { ResourcePath },
    setup: () => ({ args }),
    template: `
      <div class="text-sm font-medium">
        <span>Active Session Title</span>
        <ResourcePath v-bind="args" />
      </div>
    `,
  }),
} satisfies Meta<typeof ResourcePath>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
