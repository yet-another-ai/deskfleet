import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { useLayoutStore } from "../../stores/layout.ts"
import UiButton from "../common/UiButton.vue"
import PaneHeader from "./PaneHeader.vue"
import ResourcePath from "./ResourcePath.vue"

const meta = {
  title: "Foundational/Layout & Chrome/PaneHeader",
  component: PaneHeader,
  tags: ["autodocs"],
  render: () => ({
    components: { PaneHeader, ResourcePath, UiButton },
    setup() {
      const layout = useLayoutStore()
      layout.sidebarOpen = true
      return {}
    },
    template: `
      <div class="rounded-lg border border-ui-border bg-ui-surface">
        <PaneHeader>
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
  render: () => ({
    components: { PaneHeader, ResourcePath },
    setup() {
      const layout = useLayoutStore()
      layout.sidebarOpen = false
      return {}
    },
    template: `
      <div class="rounded-lg border border-ui-border bg-ui-surface">
        <PaneHeader>
          <span>Add Storybook for UI components</span>
          <ResourcePath :segments="['MacBook Pro (Studio)', 'deskfleet-monorepo']" />
        </PaneHeader>
      </div>
    `,
  }),
}
