import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { storybookPermission } from "../../../.storybook/storybook-fixtures.ts"
import AgentPermissions from "./AgentPermissions.vue"

const meta = {
  title: "Domain/Agent Session/AgentPermissions",
  component: AgentPermissions,
  tags: ["autodocs"],
  args: {
    permissions: [storybookPermission],
    disabled: false,
  },
} satisfies Meta<typeof AgentPermissions>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Disabled: Story = {
  args: {
    permissions: [storybookPermission],
    disabled: true,
  },
}
