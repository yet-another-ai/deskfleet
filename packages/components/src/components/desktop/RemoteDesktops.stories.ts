import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { computed, onMounted, onScopeDispose, provide, ref } from "vue"
import { useRouter } from "vue-router"
import { desktopPreviewCentral, desktopPreviewMachines } from "../../../.storybook/desktop-preview-fixture.ts"
import { accountSessionKey, useAccountSession } from "../../composables/useAccountSession.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import RemoteDesktopsView from "../../views/RemoteDesktopsView.vue"
import AppSidebar from "../sidebar/AppSidebar.vue"

const meta = {
  title: "Features/Remote desktop/Overview",
  args: { narrow: false, empty: false },
  parameters: { layout: "fullscreen", docs: { description: { component: "The independent Remote desktop capsule and its Team-wide display grid, using generated browser-local WebRTC screens." } } },
  render: args => ({
    components: { AppSidebar, RemoteDesktopsView },
    setup() {
      const account = useAccountSession()!
      const router = useRouter()
      const layout = useLayoutStore()
      const fixture = desktopPreviewCentral(account.central)
      const previousSidebar = layout.sidebarOpen
      const previousPath = router.currentRoute.value.fullPath
      layout.sidebarOpen = !args.narrow
      provide(accountSessionKey, {
        ...account,
        central: fixture.central,
        machines: computed(() => args.empty ? [] : desktopPreviewMachines),
        teamId: ref("team-1"),
        localMachineId: computed(() => undefined),
        refreshMachines: async () => {},
        openMachineRoute: () => {},
      })
      onMounted(() => { void router.replace({ name: "remote-desktops" }) })
      onScopeDispose(() => {
        fixture.dispose()
        layout.sidebarOpen = previousSidebar
        void router.replace(previousPath)
      })
      return { args }
    },
    template: `<div class="flex overflow-hidden border border-ui-border bg-ui-canvas" :style="{ height: 'calc(100vh - 32px)', width: args.narrow ? 'min(100%, 390px)' : '100%' }">
      <AppSidebar v-if="!args.narrow" />
      <main class="flex min-h-0 min-w-0 flex-1 flex-col"><RemoteDesktopsView /></main>
    </div>`,
  }),
} satisfies Meta<{ narrow: boolean; empty: boolean }>
export default meta
type Story = StoryObj<typeof meta>
export const AllDisplays: Story = {}
export const Narrow: Story = { args: { narrow: true } }
export const Empty: Story = { args: { empty: true } }
