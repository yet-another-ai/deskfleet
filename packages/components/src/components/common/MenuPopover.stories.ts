import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { ChevronDown, FolderGit2, Plus, Settings, Trash2 } from "@lucide/vue"
import { DropdownMenuItem, DropdownMenuSeparator } from "reka-ui"
import MenuPopover from "./MenuPopover.vue"

const meta = {
  title: "Foundational/Dialogs & Overlays/MenuPopover",
  component: MenuPopover,
  tags: ["autodocs"],
  argTypes: {
    label: { control: "text" },
    disabled: { control: "boolean" },
    placement: {
      control: "select",
      options: ["bottom", "top"],
    },
  },
  args: {
    label: "Workspace actions",
    disabled: false,
    placement: "bottom",
  },
  render: (args) => ({
    components: {
      MenuPopover,
      DropdownMenuItem,
      DropdownMenuSeparator,
      ChevronDown,
      FolderGit2,
      Plus,
      Settings,
      Trash2,
    },
    setup: () => ({ args }),
    template: `
      <div class="w-64">
        <MenuPopover v-bind="args">
          <template #trigger>
            <FolderGit2 :size="16" class="shrink-0 text-ui-text-muted" />
            <span class="min-w-0 flex-1 truncate font-medium">deskfleet-monorepo</span>
            <ChevronDown :size="14" class="shrink-0 text-ui-text-muted" />
          </template>
          <template #default="{ close }">
            <DropdownMenuItem as="button" type="button" class="ui-menu-item w-full" @select="close()">
              <Plus :size="14" /> New Session
            </DropdownMenuItem>
            <DropdownMenuItem as="button" type="button" class="ui-menu-item w-full" @select="close()">
              <Settings :size="14" /> Workspace Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator class="my-1 border-t border-ui-border" />
            <DropdownMenuItem as="button" type="button" class="ui-menu-item w-full text-ui-danger" @select="close()">
              <Trash2 :size="14" /> Remove Workspace
            </DropdownMenuItem>
          </template>
        </MenuPopover>
      </div>
    `,
  }),
} satisfies Meta<typeof MenuPopover>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Disabled: Story = {
  args: {
    disabled: true,
  },
}
