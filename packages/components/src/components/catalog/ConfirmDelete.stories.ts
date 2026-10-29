import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { onMounted, useTemplateRef } from "vue"
import ConfirmDelete from "./ConfirmDelete.vue"

const meta = {
  title: "Interactive & Collapsible/Pickers & Menus/ConfirmDelete",
  component: ConfirmDelete,
  tags: ["autodocs"],
  argTypes: {
    label: { control: "text" },
    question: { control: "text" },
    disabled: { control: "boolean" },
  },
  args: {
    label: "Delete Workspace",
    question: "Remove deskfleet-monorepo from this machine's catalog? Existing files on disk will not be deleted.",
    disabled: false,
    remove: async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
    },
  },
} satisfies Meta<typeof ConfirmDelete>

export default meta
type Story = StoryObj<typeof meta>

export const DefaultCollapsed: Story = {}

export const ExpandedConfirmation: Story = {
  render: (args) => ({
    components: { ConfirmDelete },
    setup() {
      const container = useTemplateRef<HTMLElement>("container")
      onMounted(() => {
        container.value?.querySelector<HTMLButtonElement>("button")?.click()
      })
      return { args }
    },
    template: `
      <div ref="container">
        <ConfirmDelete v-bind="args" />
      </div>
    `,
  }),
}
