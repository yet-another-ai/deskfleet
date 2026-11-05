import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { Copy, PanelLeft, Plus, Settings, Sparkles, Trash2 } from "@lucide/vue"
import UiButton from "./UiButton.vue"

const meta = {
  title: "Foundational/Inputs & Actions/UiButton",
  component: UiButton,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "primary", "danger", "ghost"],
    },
    size: {
      control: "select",
      options: ["default", "sm", "icon"],
    },
    type: {
      control: "select",
      options: ["button", "submit", "reset"],
    },
    label: { control: "text" },
    placeholder: { control: "boolean" },
    disabled: { control: "boolean" },
    loading: { control: "boolean" },
  },
  args: {
    variant: "default",
    size: "default",
    type: "button",
    disabled: false,
    loading: false,
  },
  render: (args) => ({
    components: { UiButton },
    setup: () => ({ args }),
    template: `<UiButton v-bind="args">Button Label</UiButton>`,
  }),
} satisfies Meta<typeof UiButton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const AllVariantsShowcase: Story = {
  render: () => ({
    components: { UiButton, Plus, Trash2, Sparkles },
    template: `
      <div class="flex flex-col gap-4">
        <div class="flex flex-wrap items-center gap-3">
          <UiButton variant="default">Default</UiButton>
          <UiButton variant="primary"><Sparkles :size="14" /> Primary</UiButton>
          <UiButton variant="danger"><Trash2 :size="14" /> Danger</UiButton>
          <UiButton variant="ghost">Ghost</UiButton>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <UiButton size="sm" variant="default">Small Default</UiButton>
          <UiButton size="sm" variant="primary">Small Primary</UiButton>
          <UiButton size="icon" variant="default" label="Add"><Plus :size="15" /></UiButton>
          <UiButton variant="primary" loading>Loading</UiButton>
          <UiButton variant="default" disabled>Disabled</UiButton>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <UiButton class="rounded-lg [corner-shape:round]" variant="default">Rounded Default</UiButton>
          <UiButton class="rounded-lg [corner-shape:round]" variant="primary"><Sparkles :size="14" /> Rounded Primary</UiButton>
          <UiButton class="rounded-lg [corner-shape:round]" variant="danger"><Trash2 :size="14" /> Rounded Danger</UiButton>
          <UiButton class="rounded-lg [corner-shape:round]" variant="ghost">Rounded Ghost</UiButton>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <UiButton class="rounded-lg [corner-shape:round]" size="sm" variant="default">Rounded Small Default</UiButton>
          <UiButton class="rounded-lg [corner-shape:round]" size="sm" variant="primary">Rounded Small Primary</UiButton>
          <UiButton class="rounded-lg [corner-shape:round]" size="icon" variant="default" label="Add"><Plus :size="15" /></UiButton>
          <UiButton class="rounded-lg [corner-shape:round]" variant="primary" loading>Rounded Loading</UiButton>
          <UiButton class="rounded-lg [corner-shape:round]" variant="default" disabled>Rounded Disabled</UiButton>
        </div>
      </div>
    `,
  }),
}

export const IconToolbarCluster: Story = {
  render: () => ({
    components: { UiButton, PanelLeft, Plus, Copy, Settings, Trash2 },
    template: `
      <div class="inline-flex items-center gap-1 rounded-lg border border-ui-border bg-ui-surface p-1">
        <UiButton variant="ghost" size="icon" label="Toggle sidebar"><PanelLeft :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
        <UiButton variant="ghost" size="icon" label="New session"><Plus :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
        <UiButton variant="ghost" size="icon" label="Copy link"><Copy :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
        <UiButton variant="ghost" size="icon" label="Settings" placeholder><Settings :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
        <UiButton variant="ghost" size="icon" label="Delete" disabled><Trash2 :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
      </div>
    `,
  }),
}
