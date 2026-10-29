import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { ref, watch } from "vue"
import UiSelect from "./UiSelect.vue"

const sampleOptions = [
  { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { value: "claude-opus-4-5", label: "Claude Opus 4.5" },
  { value: "gpt-5-codex", label: "GPT-5 Codex" },
  { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", disabled: true },
]

const meta = {
  title: "Foundational/Inputs & Actions/UiSelect",
  component: UiSelect,
  tags: ["autodocs"],
  argTypes: {
    modelValue: { control: "text" },
    searchable: { control: "boolean" },
    placeholder: { control: "text" },
    disabled: { control: "boolean" },
    required: { control: "boolean" },
    name: { control: "text" },
  },
  args: {
    modelValue: "claude-sonnet-4-5",
    options: sampleOptions,
    searchable: false,
    placeholder: "Select a model...",
    disabled: false,
    required: false,
    name: "model",
  },
  render: (args) => ({
    components: { UiSelect },
    setup() {
      const selected = ref(args.modelValue)
      watch(() => args.modelValue, (val) => { selected.value = val })
      return { args, selected }
    },
    template: `
      <div class="w-72 flex flex-col gap-2">
        <UiSelect v-bind="args" v-model="selected" />
        <span class="text-xs text-ui-text-muted">Selected: {{ selected || "(none)" }}</span>
      </div>
    `,
  }),
} satisfies Meta<typeof UiSelect>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const SearchableCombobox: Story = {
  args: {
    modelValue: "claude-sonnet-4-5",
    searchable: true,
    placeholder: "Search models...",
  },
}

export const Disabled: Story = {
  args: {
    modelValue: "claude-sonnet-4-5",
    disabled: true,
  },
}
