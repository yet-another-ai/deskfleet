import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { ref, watch } from "vue"
import UiSwitch from "./UiSwitch.vue"

const meta = {
  title: "Foundational/Inputs & Actions/UiSwitch",
  component: UiSwitch,
  tags: ["autodocs"],
  argTypes: {
    modelValue: { control: "boolean" },
    name: { control: "text" },
    disabled: { control: "boolean" },
  },
  args: {
    modelValue: false,
    name: "keep-awake",
    disabled: false,
  },
  render: (args) => ({
    components: { UiSwitch },
    setup() {
      const enabled = ref(args.modelValue)
      watch(() => args.modelValue, (val) => { enabled.value = val })
      return { args, enabled }
    },
    template: `
      <label class="inline-flex items-center gap-3 text-sm cursor-pointer">
        <UiSwitch v-bind="args" v-model="enabled" />
        <span>Keep system awake while sessions run ({{ enabled ? "On" : "Off" }})</span>
      </label>
    `,
  }),
} satisfies Meta<typeof UiSwitch>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Disabled: Story = {
  args: {
    modelValue: true,
    disabled: true,
  },
}
