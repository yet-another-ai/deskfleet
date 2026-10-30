import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { Bell, Bot, Info, Palette, Plug, ShieldCheck, SlidersHorizontal } from "@lucide/vue"
import SettingsLayout from "./SettingsLayout.vue"
import SidebarLink from "../sidebar/SidebarLink.vue"

const meta = {
  title: "Foundational/Layout & Chrome/SettingsLayout",
  component: SettingsLayout,
  tags: ["autodocs"],
  args: {
    stackOnSmallScreens: false,
    wide: false,
  },
  render: (args) => ({
    components: { SettingsLayout, SidebarLink },
    setup() {
      return { args, SlidersHorizontal, Palette, Bell, Bot, Plug, ShieldCheck, Info }
    },
    template: `
      <div class="h-[480px] flex border border-ui-border rounded-xl overflow-hidden bg-ui-canvas">
        <SettingsLayout v-bind="args">
          <template #nav>
            <SidebarLink :to="{ name: 'settings-preferences' }" :icon="SlidersHorizontal" label="Preferences" />
            <SidebarLink :to="{ name: 'settings-appearance' }" :icon="Palette" label="Appearance" />
            <SidebarLink :to="{ name: 'settings-notifications' }" :icon="Bell" label="Notifications" />
            <SidebarLink :to="{ name: 'settings-permissions' }" :icon="ShieldCheck" label="Permissions" />
            <SidebarLink :to="{ name: 'settings-agents' }" :icon="Bot" label="Agents" />
            <SidebarLink :to="{ name: 'settings-mcp-servers' }" :icon="Plug" label="MCP Servers" />
            <SidebarLink :to="{ name: 'settings-about' }" :icon="Info" label="About" />
          </template>
          <h1 class="ui-page-title mb-4">Preferences</h1>
          <p class="text-sm text-ui-text-muted">Configure local machine behavior, startup options, and worktree storage locations.</p>
        </SettingsLayout>
      </div>
    `,
  }),
} satisfies Meta<typeof SettingsLayout>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
