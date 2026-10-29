import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { ref, watch } from "vue"
import UiCheckbox from "./UiCheckbox.vue"

const meta = {
  title: "Foundational/Inputs & Actions/UiCheckbox",
  component: UiCheckbox,
  tags: ["autodocs"],
  argTypes: {
    modelValue: { control: "boolean" },
    name: { control: "text" },
    value: { control: "text" },
    disabled: { control: "boolean" },
    required: { control: "boolean" },
  },
  args: {
    modelValue: false,
    name: "show-hidden",
    value: "yes",
    disabled: false,
    required: false,
  },
  render: (args) => ({
    components: { UiCheckbox },
    setup() {
      const checked = ref(args.modelValue)
      watch(() => args.modelValue, (val) => { checked.value = val })
      return { args, checked }
    },
    template: `
      <label class="inline-flex items-center gap-2 text-sm cursor-pointer">
        <UiCheckbox v-bind="args" v-model="checked" />
        <span>Show hidden files ({{ checked ? "Checked" : "Unchecked" }})</span>
      </label>
    `,
  }),
} satisfies Meta<typeof UiCheckbox>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Disabled: Story = {
  args: {
    modelValue: true,
    disabled: true,
  },
}
