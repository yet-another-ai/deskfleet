import type { Meta, StoryObj } from "@storybook/vue3-vite"
import ProviderWorkspaceImportDialog from "./ProviderWorkspaceImportDialog.vue"

const meta = {
  title: "Settings/ProviderWorkspaceImportDialog",
  component: ProviderWorkspaceImportDialog,
  args: {
    provider: { id: "codex-work", name: "Codex", template: "codex", env: {} },
    machineName: "MacBook Pro",
  },
} satisfies Meta<typeof ProviderWorkspaceImportDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
