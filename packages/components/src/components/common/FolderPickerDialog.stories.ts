import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { ref } from "vue"
import type { DirectoryListing } from "@deskfleet/client/filesystem"
import { createStorybookDesktopApi } from "../../../.storybook/storybook-fixtures.ts"
import FolderPickerDialog from "./FolderPickerDialog.vue"
import UiButton from "./UiButton.vue"

const defaultBrowse = createStorybookDesktopApi().filesystem.listDirectories

const emptyBrowse = async (path = "/workspace/empty"): Promise<DirectoryListing> => ({
  path,
  parentPath: "/workspace",
  homePath: "/Users/ada",
  roots: [{ name: "/", path: "/" }, { name: "Home", path: "/Users/ada" }],
  directories: [],
})

const failingBrowse = async (): Promise<DirectoryListing> => {
  throw new Error("EACCES: permission denied, scandir '/System/Volumes/Data/private'")
}

const meta = {
  title: "Foundational/Dialogs & Overlays/FolderPickerDialog",
  component: FolderPickerDialog,
  tags: ["autodocs"],
  argTypes: {
    initialPath: { control: "text" },
    machineName: { control: "text" },
  },
  args: {
    browse: defaultBrowse,
    initialPath: "/workspace",
    machineName: "MacBook Pro (Studio)",
  },
  render: (args) => ({
    components: { FolderPickerDialog, UiButton },
    setup() {
      const open = ref(true)
      const selectedPath = ref<string | null>(null)
      function onSelect(path: string) {
        selectedPath.value = path
        open.value = false
      }
      return { args, open, selectedPath, onSelect }
    },
    template: `
      <div class="flex flex-col items-start gap-3">
        <div class="flex items-center gap-3">
          <UiButton variant="primary" @click="open = true">Browse Folders...</UiButton>
          <span v-if="selectedPath" class="text-xs font-mono text-ui-text-muted">
            Selected: {{ selectedPath }}
          </span>
        </div>
        <FolderPickerDialog
          v-if="open"
          v-bind="args"
          @select="onSelect"
          @cancel="open = false"
        />
      </div>
    `,
  }),
} satisfies Meta<typeof FolderPickerDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const EmptyFolder: Story = {
  args: {
    browse: emptyBrowse,
    initialPath: "/workspace/empty",
  },
}

export const ErrorState: Story = {
  args: {
    browse: failingBrowse,
    initialPath: "/System/Volumes/Data/private",
  },
}
