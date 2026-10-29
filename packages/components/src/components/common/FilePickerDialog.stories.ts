import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { ref } from "vue"
import type { FileEntry, FilesApi } from "@deskfleet/client/files"
import { createStorybookDesktopApi } from "../../../.storybook/storybook-fixtures.ts"
import FilePickerDialog from "./FilePickerDialog.vue"
import UiButton from "./UiButton.vue"

const defaultFilesApi: FilesApi = createStorybookDesktopApi().files!

const emptyFilesApi: FilesApi = {
  ...defaultFilesApi,
  list: async (_target, path = "/workspace/empty") => ({
    path,
    parentPath: "/workspace",
    homePath: "/Users/ada",
    roots: [{ name: "/", path: "/" }, { name: "Workspace", path: "/workspace" }],
    entries: [],
  }),
}

const errorFilesApi: FilesApi = {
  ...defaultFilesApi,
  list: async () => {
    throw new Error("Permission denied: unable to read directory /root/private")
  },
}

const meta = {
  title: "Foundational/Dialogs & Overlays/FilePickerDialog",
  component: FilePickerDialog,
  tags: ["autodocs"],
  argTypes: {
    initialPath: { control: "text" },
    machineName: { control: "text" },
  },
  args: {
    api: defaultFilesApi,
    target: { kind: "local" },
    initialPath: "/workspace/deskfleet",
    machineName: "MacBook Pro (Studio)",
  },
  render: (args) => ({
    components: { FilePickerDialog, UiButton },
    setup() {
      const open = ref(true)
      const selected = ref<FileEntry[]>([])
      function onSelect(entries: FileEntry[]) {
        selected.value = entries
        open.value = false
      }
      return { args, open, selected, onSelect }
    },
    template: `
      <div class="flex flex-col items-start gap-3">
        <div class="flex items-center gap-3">
          <UiButton variant="primary" @click="open = true">Choose Files...</UiButton>
          <span v-if="selected.length" class="text-xs text-ui-text-muted font-mono">
            Selected: {{ selected.map(e => e.name).join(", ") }}
          </span>
        </div>
        <FilePickerDialog
          v-if="open"
          v-bind="args"
          @select="onSelect"
          @cancel="open = false"
        />
      </div>
    `,
  }),
} satisfies Meta<typeof FilePickerDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const EmptyDirectory: Story = {
  args: {
    api: emptyFilesApi,
    initialPath: "/workspace/empty",
    machineName: "MacBook Pro (Studio)",
  },
}

export const ErrorState: Story = {
  args: {
    api: errorFilesApi,
    initialPath: "/root/private",
    machineName: "Linux Build Server",
  },
}
