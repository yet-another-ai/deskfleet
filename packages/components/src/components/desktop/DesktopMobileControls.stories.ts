import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { ref } from "vue"
import DesktopMobileControls from "./DesktopMobileControls.vue"
import type { DesktopPointerMode } from "../../composables/useDesktopTouch.ts"

const meta = {
  title: "Features/Remote desktop/Mobile controls",
  args: { width: 390, height: 700 },
  render: args => ({
    components: { DesktopMobileControls },
    setup() {
      const stage = ref<HTMLElement | null>(null)
      const mode = ref<DesktopPointerMode>("absolute")
      const send = () => true
      return { args, stage, mode, send }
    },
    template: `<div ref="stage" class="relative overflow-hidden rounded-xl bg-ui-desktop text-ui-text" :style="{ width: args.width + 'px', maxWidth: '100%', height: args.height + 'px' }">
      <div class="absolute inset-x-4 top-32 rounded-lg border border-ui-border bg-ui-surface p-4 font-mono text-sm">$ deskfleet<br/><span class="text-ui-text-muted">Remote desktop preview</span></div>
      <div class="absolute top-3 right-3 max-w-[calc(100%-1.5rem)] rounded-xl border border-ui-border bg-ui-surface p-1 shadow-ui-popover"><DesktopMobileControls v-model="mode" :stage="stage" :enabled="true" platform="linux" :send="send" /></div>
    </div>`,
  }),
} satisfies Meta<{ width: number; height: number }>
export default meta
type Story = StoryObj<typeof meta>
export const Phone: Story = {}
export const Tablet: Story = { args: { width: 900, height: 600 } }
export const Landscape: Story = { args: { width: 700, height: 330 } }
