import type { Meta, StoryObj } from "@storybook/vue3-vite"
import SessionContextMenu from "./SessionContextMenu.vue"

const meta = {
  title: "Interactive & Collapsible/Pickers & Menus/SessionContextMenu",
  component: SessionContextMenu,
  tags: ["autodocs"],
  args: {
    sessionId: "sess-1",
    machineId: "machine-1",
    title: "Add Storybook for UI components",
    archiveState: "active",
    disabled: false,
  },
  render: (args) => ({
    components: { SessionContextMenu },
    setup: () => ({ args }),
    template: `
      <SessionContextMenu v-bind="args">
        <button type="button" class="flex w-72 cursor-context-menu items-center justify-between rounded-lg border border-ui-border bg-ui-surface px-3 py-2 text-left text-sm hover:bg-ui-hover">
          <span class="truncate font-medium">{{ args.title }}</span>
          <span class="text-xs text-ui-text-muted">Right-click me</span>
        </button>
      </SessionContextMenu>
    `,
  }),
} satisfies Meta<typeof SessionContextMenu>

export default meta
type Story = StoryObj<typeof meta>

export const ActiveSession: Story = {}

export const ArchivedSession: Story = {
  args: {
    sessionId: "sess-2",
    machineId: "machine-1",
    title: "Refactor WebRTC signaling channel",
    archiveState: "archived",
  },
}
