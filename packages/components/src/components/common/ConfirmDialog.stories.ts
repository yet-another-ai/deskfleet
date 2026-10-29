import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { ref } from "vue"
import ConfirmDialog from "./ConfirmDialog.vue"
import UiButton from "./UiButton.vue"

const meta = {
  title: "Foundational/Dialogs & Overlays/ConfirmDialog",
  component: ConfirmDialog,
  tags: ["autodocs"],
  argTypes: {
    title: { control: "text" },
    description: { control: "text" },
    confirmLabel: { control: "text" },
    tone: {
      control: "select",
      options: ["danger", "primary"],
    },
  },
  args: {
    title: "Delete workspace?",
    description: "Removing this workspace deletes its catalog binding, but leaves files on disk intact.",
    confirmLabel: "Delete Workspace",
    tone: "danger",
    confirm: async () => {
      await new Promise(resolve => setTimeout(resolve, 350))
    },
  },
  render: (args) => ({
    components: { ConfirmDialog, UiButton },
    setup() {
      const open = ref(true)
      return { args, open }
    },
    template: `
      <div>
        <UiButton :variant="args.tone ?? 'danger'" @click="open = true">
          Open Confirm Dialog
        </UiButton>
        <ConfirmDialog
          v-if="open"
          v-bind="args"
          @close="open = false"
        />
      </div>
    `,
  }),
} satisfies Meta<typeof ConfirmDialog>

export default meta
type Story = StoryObj<typeof meta>

export const DangerConfirmation: Story = {}

export const PrimaryConfirmation: Story = {
  args: {
    title: "Archive completed session?",
    description: "Archived sessions move out of the active sidebar list and can be restored anytime.",
    confirmLabel: "Archive Session",
    tone: "primary",
  },
}
