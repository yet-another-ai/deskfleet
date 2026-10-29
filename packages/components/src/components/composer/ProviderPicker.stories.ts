import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { ref } from "vue"
import { storybookProviders } from "../../../.storybook/storybook-fixtures.ts"
import ProviderPicker from "./ProviderPicker.vue"

const meta = {
  title: "Interactive & Collapsible/Pickers & Menus/ProviderPicker",
  component: ProviderPicker,
  tags: ["autodocs"],
  args: {
    providers: storybookProviders,
    modelValue: "claude-code",
    disabled: false,
  },
  render: (args) => ({
    components: { ProviderPicker },
    setup() {
      const selected = ref(args.modelValue)
      return { args, selected }
    },
    template: `<ProviderPicker v-bind="args" v-model="selected" />`,
  }),
} satisfies Meta<typeof ProviderPicker>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Disabled: Story = {
  args: {
    modelValue: "cursor",
    disabled: true,
  },
}
