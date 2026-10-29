import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { useLayoutStore } from "../../stores/layout.ts"
import WindowToolbar from "./WindowToolbar.vue"

const meta = {
  title: "Foundational/Layout & Chrome/WindowToolbar",
  component: WindowToolbar,
  tags: ["autodocs"],
  render: () => ({
    components: { WindowToolbar },
    setup() {
      const layout = useLayoutStore()
      layout.sidebarOpen = true
      return { layout }
    },
    template: `
      <div class="flex items-center gap-4">
        <WindowToolbar />
        <span class="text-xs text-ui-text-muted">
          Sidebar: {{ layout.sidebarOpen ? "Open" : "Collapsed" }}
        </span>
      </div>
    `,
  }),
} satisfies Meta<typeof WindowToolbar>

export default meta
type Story = StoryObj<typeof meta>

export const DefaultSidebarOpen: Story = {}

export const SidebarCollapsed: Story = {
  render: () => ({
    components: { WindowToolbar },
    setup() {
      const layout = useLayoutStore()
      layout.sidebarOpen = false
      return { layout }
    },
    template: `
      <div class="flex items-center gap-4">
        <WindowToolbar />
        <span class="text-xs text-ui-text-muted">
          Sidebar: {{ layout.sidebarOpen ? "Open" : "Collapsed" }}
        </span>
      </div>
    `,
  }),
}
