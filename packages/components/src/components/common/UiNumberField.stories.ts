import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { ref, watch } from "vue"
import UiNumberField from "./UiNumberField.vue"

const meta = {
  title: "Foundational/Inputs & Actions/UiNumberField",
  component: UiNumberField,
  tags: ["autodocs"],
  argTypes: {
    modelValue: { control: "number" },
    name: { control: "text" },
    min: { control: "number" },
    max: { control: "number" },
    disabled: { control: "boolean" },
    required: { control: "boolean" },
  },
  args: {
    modelValue: 15,
    name: "interval-minutes",
    min: 1,
    max: 120,
    disabled: false,
    required: false,
  },
  render: (args) => ({
    components: { UiNumberField },
    setup() {
      const value = ref(args.modelValue)
      watch(() => args.modelValue, (val) => { value.value = val })
      return { args, value }
    },
    template: `
      <div class="flex items-center gap-3">
        <UiNumberField v-bind="args" v-model="value" />
        <span class="text-xs text-ui-text-muted">Value: {{ value }}</span>
      </div>
    `,
  }),
} satisfies Meta<typeof UiNumberField>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Disabled: Story = {
  args: {
    modelValue: 30,
    disabled: true,
  },
}
