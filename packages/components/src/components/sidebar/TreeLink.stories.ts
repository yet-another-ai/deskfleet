import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { Archive, Bot, MonitorPlay, SquareTerminal } from "@lucide/vue"
import TreeLink from "./TreeLink.vue"
import IconButton from "../common/IconButton.vue"
import SessionWorkingIndicator from "./SessionWorkingIndicator.vue"

const meta = {
  title: "Foundational/Layout & Chrome/TreeLink",
  component: TreeLink,
  tags: ["autodocs"],
  args: {
    to: { name: "machine-control", params: { machineId: "machine-1" } },
    icon: SquareTerminal as never,
    label: "Local Control",
    depth: 0,
  },
  render: (args) => ({
    components: { TreeLink },
    setup: () => ({ args }),
    template: "<div class='w-64 p-2 bg-ui-sidebar border border-ui-border rounded-lg'><TreeLink v-bind='args' /></div>",
  }),
} satisfies Meta<typeof TreeLink>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const HierarchyAndActionsShowcase: Story = {
  render: () => ({
    components: { TreeLink, IconButton, SessionWorkingIndicator },
    setup: () => ({ Bot, Archive, MonitorPlay, SquareTerminal }),
    template: `
      <div class="w-64 p-2 flex flex-col gap-1 bg-ui-sidebar border border-ui-border rounded-lg">
        <TreeLink :to="{ name: 'machine-control', params: { machineId: 'machine-1' } }" :icon="MonitorPlay" label="Remote Control" :depth="0" />
        <TreeLink :to="{ name: 'session', params: { sessionId: 'sess-1' } }" :icon="Bot" label="Add Storybook for UI components" :depth="1">
          <template #trailing>
            <SessionWorkingIndicator />
          </template>
          <template #actions>
            <IconButton :icon="Archive" label="Archive session" />
          </template>
        </TreeLink>
        <TreeLink :to="{ name: 'terminal', params: { terminalId: 'term-1' } }" :icon="SquareTerminal" label="zsh — deskfleet" :depth="2" />
      </div>
    `,
  }),
}
