import type { Meta, StoryObj } from "@storybook/vue3-vite"
import CopyField from "./CopyField.vue"

const meta = {
  title: "Foundational/Inputs & Actions/CopyField",
  component: CopyField,
  tags: ["autodocs"],
  argTypes: {
    label: { control: "text" },
    value: { control: "text" },
    multiline: { control: "boolean" },
  },
  args: {
    label: "Enrollment Token",
    value: "df_machine_tok_98a7bc654321fedcba",
    multiline: false,
  },
} satisfies Meta<typeof CopyField>

export default meta
type Story = StoryObj<typeof meta>

export const SingleLine: Story = {}

export const Multiline: Story = {
  args: {
    label: "Headless Service Configuration",
    value: `[service]\nserver_url = "https://fleet.deskfleet.dev"\nmachine_id = "machine-prod-01"\nauth_token = "df_machine_tok_98a7bc654321fedcba"`,
    multiline: true,
  },
}
