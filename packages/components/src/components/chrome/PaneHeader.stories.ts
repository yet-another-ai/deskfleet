import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { useLayoutStore } from "../../stores/layout.ts"
import UiButton from "../common/UiButton.vue"
import PaneHeader from "./PaneHeader.vue"
import ResourcePath from "./ResourcePath.vue"

const meta = {
  title: "Foundational/Layout & Chrome/PaneHeader",
  component: PaneHeader,
  tags: ["autodocs"],
  argTypes: {
    hideDetails: { control: "boolean" },
  },
  args: {
    hideDetails: false,
  },
  render: (args) => ({
    components: { PaneHeader, ResourcePath, UiButton },
    setup() {
      const layout = useLayoutStore()
      layout.sidebarOpen = true
      layout.detailsOpen = true
      return { args }
    },
    template: `
      <div class="rounded-lg border border-ui-border bg-ui-surface">
        <PaneHeader v-bind="args">
          <span>Add Storybook for UI components</span>
          <ResourcePath :segments="['MacBook Pro (Studio)', 'deskfleet-monorepo']" />
          <template #actions>
            <UiButton size="sm" variant="default">Share</UiButton>
          </template>
        </PaneHeader>
      </div>
    `,
  }),
} satisfies Meta<typeof PaneHeader>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const SidebarCollapsedWithWindowToolbar: Story = {
  render: (args) => ({
    components: { PaneHeader, ResourcePath },
    setup() {
      const layout = useLayoutStore()
      layout.sidebarOpen = false
      layout.detailsOpen = false
      return { args }
    },
    template: `
      <div class="rounded-lg border border-ui-border bg-ui-surface">
        <PaneHeader v-bind="args">
          <span>Add Storybook for UI components</span>
          <ResourcePath :segments="['MacBook Pro (Studio)', 'deskfleet-monorepo']" />
        </PaneHeader>
      </div>
    `,
  }),
}
