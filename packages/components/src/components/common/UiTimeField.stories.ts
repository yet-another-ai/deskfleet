import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { ref, watch } from "vue"
import UiTimeField from "./UiTimeField.vue"

const meta = {
  title: "Foundational/Inputs & Actions/UiTimeField",
  component: UiTimeField,
  tags: ["autodocs"],
  argTypes: {
    modelValue: { control: "text" },
    name: { control: "text" },
    required: { control: "boolean" },
    disabled: { control: "boolean" },
    locale: {
      control: "select",
      options: ["en-US", "zh-cmn-Hans-CN"],
    },
  },
  args: {
    modelValue: "09:30",
    name: "schedule-time",
    required: false,
    disabled: false,
    locale: "en-US",
  },
  render: (args) => ({
    components: { UiTimeField },
    setup() {
      const time = ref(args.modelValue)
      watch(() => args.modelValue, (val) => { time.value = val })
      return { args, time }
    },
    template: `
      <div class="flex items-center gap-3">
        <UiTimeField v-bind="args" v-model="time" />
        <span class="text-xs font-mono text-ui-text-muted">Value: {{ time || "(empty)" }}</span>
      </div>
    `,
  }),
} satisfies Meta<typeof UiTimeField>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Disabled: Story = {
  args: {
    modelValue: "12:00",
    disabled: true,
  },
}
