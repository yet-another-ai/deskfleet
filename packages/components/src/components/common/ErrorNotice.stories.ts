import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { useI18n } from "vue-i18n"
import { ref } from "vue"
import ErrorNotice from "./ErrorNotice.vue"
import UiButton from "./UiButton.vue"

const meta = {
  title: "Foundational/Feedback/ErrorNotice",
  component: ErrorNotice,
  tags: ["autodocs"],
  args: { error: "The remote operation could not be completed.\nConnection closed before the response arrived." },
  render: args => ({
    components: { ErrorNotice },
    setup: () => ({ args }),
    template: '<div class="max-w-md"><ErrorNotice v-bind="args" /></div>',
  }),
} satisfies Meta<typeof ErrorNotice>

export default meta
type Story = StoryObj<typeof meta>

export const Generic: Story = {}
export const DesktopConnection: Story = {
  args: {
    error: "Capture failed: DXGI_ERROR_ACCESS_LOST\nThe desktop session is locked.",
  },
  render: args => ({
    components: { ErrorNotice },
    setup: () => ({ args, t: useI18n().t }),
    template: '<div class="max-w-md"><ErrorNotice v-bind="args" :title="t(\'errors.desktopConnectionTitle\')" :description="t(\'errors.desktopUnlockHint\')" /></div>',
  }),
}
export const RelayFreePlan: Story = { args: { relayDeniedReason: "free_plan" } }
export const RelayAllowance: Story = { args: { relayDeniedReason: "turn_quota_exhausted" } }
export const RelayUnavailable: Story = { args: { relayDeniedReason: "metering_unavailable" } }
export const LongDetails: Story = {
  args: { error: `Capture failed: ${"diagnostic".repeat(100)}\n${"Additional diagnostic line\n".repeat(40)}` },
}
export const WithRetry: Story = {
  render: args => ({
    components: { ErrorNotice, UiButton },
    setup: () => ({ args, failed: ref(true), t: useI18n().t }),
    template: '<div class="max-w-md"><ErrorNotice v-if="failed" v-bind="args"><UiButton size="sm" @click="failed = false">{{ t("errors.retry") }}</UiButton></ErrorNotice><p v-else role="status">Recovered</p></div>',
  }),
}
