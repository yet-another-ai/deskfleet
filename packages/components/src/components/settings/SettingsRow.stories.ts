import type { Meta, StoryObj } from "@storybook/vue3-vite"
import SettingsRow from "./SettingsRow.vue"
import UiButton from "../common/UiButton.vue"
import UiSwitch from "../common/UiSwitch.vue"

const meta = {
  title: "Foundational/Layout & Chrome/SettingsRow",
  component: SettingsRow,
  tags: ["autodocs"],
  args: {
    label: "Keep computer awake",
    labelId: "row-label",
    descriptionId: "row-desc",
  },
} satisfies Meta<typeof SettingsRow>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: (args) => ({
    components: { SettingsRow, UiSwitch, UiButton },
    setup: () => ({ args }),
    template: `
      <div class="ui-card divide-y divide-ui-border px-4">
        <SettingsRow v-bind="args">
          <template #description>Prevent the system from sleeping while an agent session is actively running.</template>
          <UiSwitch :model-value="true" aria-labelledby="row-label" aria-describedby="row-desc" />
        </SettingsRow>
        <SettingsRow label="Worktree directory" label-id="wt-label" description-id="wt-desc">
          <template #description>Default directory where isolated session worktrees are created.</template>
          <UiButton type="button">Choose Folder…</UiButton>
        </SettingsRow>
      </div>
    `,
  }),
}
