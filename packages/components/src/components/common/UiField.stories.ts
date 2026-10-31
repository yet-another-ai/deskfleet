import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { ref } from "vue"
import UiField from "./UiField.vue"

const meta = {
  title: "Foundational/Inputs & Actions/UiField",
  component: UiField,
  tags: ["autodocs"],
  argTypes: {
    label: { control: "text" },
    type: { control: "select", options: ["text", "password", "email"] },
    multiline: { control: "boolean" },
    readonly: { control: "boolean" },
    disabled: { control: "boolean" },
    hint: { control: "text" },
  },
  args: {
    label: "Display name",
    type: "text",
    hint: undefined,
    multiline: false,
    readonly: false,
    disabled: false,
  },
  render: (args) => ({
    components: { UiField },
    setup() {
      const value = ref("")
      return { args, value }
    },
    template: `
      <div class="max-w-sm">
        <UiField v-bind="args" v-model="value" />
      </div>
    `,
  }),
} satisfies Meta<typeof UiField>

export default meta
type Story = StoryObj<typeof meta>

export const Text: Story = {}

export const PasswordWithHint: Story = {
  args: {
    label: "New password",
    type: "password",
    hint: "15–128 characters. Spaces and password managers are welcome.",
  },
}
