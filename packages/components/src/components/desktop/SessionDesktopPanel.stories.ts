import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { computed, onMounted, onScopeDispose, onUnmounted, provide, ref } from "vue"
import { useRouter } from "vue-router"
import { desktopPreviewCentral, desktopPreviewMachines as machines } from "../../../.storybook/desktop-preview-fixture.ts"
import { accountSessionKey, useAccountSession } from "../../composables/useAccountSession.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import SessionView from "../../views/SessionView.vue"
import MobileWindowManager from "../chrome/MobileWindowManager.vue"
import WindowManager from "../chrome/WindowManager.vue"

const meta = {
  title: "Features/Remote desktop/Session dock",
  args: { mobile: false },
  parameters: { layout: "fullscreen", docs: { description: { component: "The real Session conversation and its Changes/Desktops windows, backed by generated browser-local WebRTC screens. The Session belongs to machine-1 while account selection points to another machine. Open the Desktops tab (or mobile view) to start previews." } } },
  render: (args) => ({
    components: { WindowManager, MobileWindowManager },
    setup() {
      const account = useAccountSession()!
      const router = useRouter()
      const layout = useLayoutStore()
      const terminals = useTerminalsStore()
      const agents = useAgentSessionsStore()
      const previousAgentMethods = { open: agents.open, attend: agents.attend, leave: agents.leave }
      const previousAgentState = agents.state
      const previousAgentError = agents.error
      // Keep the seeded conversation visible without opening a real agent channel.
      agents.open = async () => { agents.state = "connected"; agents.error = null }
      agents.attend = async () => true
      agents.leave = async () => {}
      agents.state = "connected"
      agents.error = null
      onUnmounted(() => {
        Object.assign(agents, previousAgentMethods)
        agents.state = previousAgentState
        agents.error = previousAgentError
      })
      const fixture = desktopPreviewCentral(account.central)
      const selectedMachineId = ref("fixture-studio")
      provide(accountSessionKey, {
        ...account,
        central: fixture.central,
        machines: ref(machines),
        machineId: selectedMachineId,
        machine: computed(() => machines.find(machine => machine.id === selectedMachineId.value)),
        teamId: ref("team-1"),
        localMachineId: computed(() => undefined),
        refreshMachines: async () => {},
        openMachineRoute: () => {},
      })

      // Storybook's default route is empty; the desktop Chat window uses RouterView.
      const previousComponent = router.getRoutes().find(route => route.name === "session")?.components?.default
      const removeRoute = router.addRoute({ path: "/sessions/:sessionId", name: "session", component: SessionView, props: true })
      const storageKey = "deskfleet.window-layout-v4:sess-1"
      const previousLayout = localStorage.getItem(storageKey)
      localStorage.removeItem(storageKey)
      const previousTerminals = terminals.sessions
      const previousSidebarOpen = layout.sidebarOpen
      const previousTerminalPanelOpen = layout.terminalPanelOpen
      terminals.sessions = []
      layout.sidebarOpen = false
      layout.terminalPanelOpen = false

      const ready = ref(false)
      let disposed = false
      onMounted(async () => {
        await router.replace({ name: "session", params: { sessionId: "sess-1" }, force: true })
        if (!disposed) ready.value = true
      })
      onScopeDispose(() => {
        disposed = true
        fixture.dispose()
        removeRoute()
        router.addRoute({ path: "/sessions/:sessionId", name: "session", component: previousComponent ?? { template: "<div />" }, props: true })
        terminals.sessions = previousTerminals
        layout.sidebarOpen = previousSidebarOpen
        layout.terminalPanelOpen = previousTerminalPanelOpen
        if (previousLayout === null) localStorage.removeItem(storageKey)
        else localStorage.setItem(storageKey, previousLayout)
      })
      return { args, ready }
    },
    template: `<div class="flex min-h-0 min-w-0 flex-col overflow-hidden bg-ui-canvas" :style="{ height: 'calc(100vh - 32px)', width: args.mobile ? 'min(100%, 420px)' : '100%' }">
      <MobileWindowManager v-if="ready && args.mobile" session-id="sess-1" />
      <WindowManager v-else-if="ready" session-id="sess-1" />
    </div>`,
  }),
} satisfies Meta<{ mobile: boolean }>
export default meta
type Story = StoryObj<typeof meta>
export const SessionDock: Story = {}
export const NarrowSession: Story = { args: { mobile: true } }
