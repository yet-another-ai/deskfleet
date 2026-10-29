import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { ref } from "vue"
import PasswordField from "./PasswordField.vue"

const meta = {
  title: "Foundational/Inputs & Actions/PasswordField",
  component: PasswordField,
  tags: ["autodocs"],
  args: {
    label: "Password",
    purpose: "current",
    modelValue: "",
    disabled: false,
    autofocus: false,
  },
  render: (args) => ({
    components: { PasswordField },
    setup() {
      const value = ref(args.modelValue)
      return { args, value }
    },
    template: `
      <div class="max-w-sm">
        <PasswordField v-bind="args" v-model="value" />
      </div>
    `,
  }),
} satisfies Meta<typeof PasswordField>

export default meta
type Story = StoryObj<typeof meta>

export const CurrentPassword: Story = {
  args: {
    label: "Password",
    purpose: "current",
    modelValue: "correct-horse-battery-staple",
  },
}

export const NewPasswordWithHint: Story = {
  args: {
    label: "New password",
    purpose: "new",
    modelValue: "",
  },
}
