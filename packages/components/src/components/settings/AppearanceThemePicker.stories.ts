import type { Meta, StoryObj } from "@storybook/vue3-vite"
import AppearanceThemePicker from "./AppearanceThemePicker.vue"

const meta = {
  title: "Interactive & Collapsible/Pickers & Menus/AppearanceThemePicker",
  component: AppearanceThemePicker,
  tags: ["autodocs"],
  args: {
    modelValue: "light",
    disabled: false,
  },
} satisfies Meta<typeof AppearanceThemePicker>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Disabled: Story = {
  args: {
    modelValue: "system",
    disabled: true,
  },
}
