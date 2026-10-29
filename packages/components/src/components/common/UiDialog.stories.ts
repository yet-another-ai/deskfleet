import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { DialogDescription, DialogTitle } from "reka-ui"
import { ref, watch } from "vue"
import UiButton from "./UiButton.vue"
import UiDialog from "./UiDialog.vue"

const meta = {
  title: "Foundational/Dialogs & Overlays/UiDialog",
  component: UiDialog,
  tags: ["autodocs"],
  argTypes: {
    open: { control: "boolean" },
    preventClose: { control: "boolean" },
    title: { control: "text" },
    described: { control: "boolean" },
  },
  args: {
    open: true,
    preventClose: false,
    title: "",
    described: true,
  },
  render: (args) => ({
    components: { UiDialog, UiButton, DialogTitle, DialogDescription },
    setup() {
      const isOpen = ref(args.open ?? true)
      watch(() => args.open, (val) => {
        if (val !== undefined) isOpen.value = val
      })
      return { args, isOpen }
    },
    template: `
      <div>
        <UiButton variant="primary" @click="isOpen = true">Open Dialog</UiButton>
        <UiDialog
          v-bind="args"
          v-model:open="isOpen"
          class="w-[26rem]"
        >
          <DialogTitle class="ui-dialog-title">Configure Session Environment</DialogTitle>
          <DialogDescription class="ui-dialog-description">
            Choose whether this agent session executes in an isolated Git worktree or directly in the workspace directory.
          </DialogDescription>
          <div class="ui-dialog-actions">
            <UiButton type="button" :disabled="args.preventClose" @click="isOpen = false">Cancel</UiButton>
            <UiButton variant="primary" type="button" @click="isOpen = false">Confirm</UiButton>
          </div>
        </UiDialog>
      </div>
    `,
  }),
} satisfies Meta<typeof UiDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
