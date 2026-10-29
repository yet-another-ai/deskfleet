import type { Meta, StoryObj } from "@storybook/vue3-vite"
import type { LocalApplicationsApi } from "@deskfleet/client/applications"
import { createStorybookDesktopApi } from "../../../.storybook/storybook-fixtures.ts"
import OpenWithMenu from "./OpenWithMenu.vue"

const defaultApplicationsApi: LocalApplicationsApi = createStorybookDesktopApi().applications!

const meta = {
  title: "Interactive & Collapsible/Pickers & Menus/OpenWithMenu",
  component: OpenWithMenu,
  tags: ["autodocs"],
  argTypes: {
    machineId: { control: "text" },
    workspaceId: { control: "text" },
    worktreeId: { control: "text" },
    directoryIndex: { control: "number" },
    directoryPath: { control: "text" },
    compact: { control: "boolean" },
    split: { control: "boolean" },
    hideError: { control: "boolean" },
    disabled: { control: "boolean" },
  },
  args: {
    api: defaultApplicationsApi,
    machineId: "machine-1",
    workspaceId: "ws-1",
    compact: false,
    split: false,
    hideError: false,
    disabled: false,
  },
} satisfies Meta<typeof OpenWithMenu>

export default meta
type Story = StoryObj<typeof meta>

export const DefaultDropdown: Story = {}

export const SplitPrimaryEditorButton: Story = {
  args: {
    split: true,
  },
}

export const CompactIconOnly: Story = {
  args: {
    compact: true,
    directoryIndex: 1,
    directoryPath: "/workspace/deskfleet-docs",
  },
}
