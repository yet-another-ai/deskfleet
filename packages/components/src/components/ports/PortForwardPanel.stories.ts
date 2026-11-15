import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { getClient } from "@deskfleet/client/platform"
import { computed, onMounted, onScopeDispose, provide, ref } from "vue"
import { useRouter } from "vue-router"
import type { PortForward, PortForwardTarget, PortsApi } from "../../../../client/src/ports.ts"
import { accountSessionKey, useAccountSession } from "../../composables/useAccountSession.ts"
import { platformClientKey } from "../../composables/usePlatformClient.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import RemoteControlView from "../../views/RemoteControlView.vue"
import PortForwardPanel from "./PortForwardPanel.vue"

function portFixture(target: PortForwardTarget, populated: boolean): PortsApi {
  let forwards: PortForward[] = populated ? [
    { id: "preview", target, localHost: "127.0.0.1", localPort: 3000, targetHost: "127.0.0.1", targetPort: 3000 },
    { id: "database", target, localHost: "127.0.0.1", localPort: 15432, targetHost: "::1", targetPort: 5432 },
  ] : []
  let nextId = 1
  return {
    async list() { return structuredClone(forwards) },
    async start(request) {
      const localPort = request.localPort || 45000 + nextId
      if (forwards.some(forward => forward.localPort === localPort)) throw new Error("This local port is already in use.")
      const forward: PortForward = {
        id: `forward-${nextId++}`,
        target: { ...request.target },
        localHost: "127.0.0.1", localPort,
        targetHost: request.targetHost ?? "127.0.0.1", targetPort: request.targetPort,
      }
      forwards.push(forward)
      return structuredClone(forward)
    },
    async stop(id) { forwards = forwards.filter(forward => forward.id !== id) },
  }
}

const meta = {
  title: "Features/Remote control/Port forwarding",
  args: { populated: false, online: true, narrow: false },
  parameters: { layout: "padded" },
  render: args => ({
    components: { PortForwardPanel },
    setup() {
      const target: PortForwardTarget = { teamId: "example-team", machineId: "build-machine" }
      const api = portFixture(target, args.populated)
      return { args, target, api }
    },
    template: `<div class="mx-auto min-w-0" :style="{ width: args.narrow ? 'min(100%, 360px)' : 'min(100%, 1000px)' }">
      <PortForwardPanel :api="api" :target="target" machine-name="Build machine" :online="args.online" :active="true" />
    </div>`,
  }),
} satisfies Meta<{ populated: boolean; online: boolean; narrow: boolean }>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {}
export const Active: Story = { args: { populated: true } }
export const Offline: Story = { args: { populated: true, online: false } }
export const Narrow: Story = { args: { narrow: true } }

export const RemoteControlTab: Story = {
  render: args => ({
    components: { RemoteControlView },
    setup() {
      const host = getClient(), fleet = useFleetStore(), account = useAccountSession()!
      const router = useRouter()
      const ready = ref(false)
      const hostTarget = host.target!
      const previousLocal = hostTarget.local
      const previousDesktop = fleet.localDesktopTarget
      const previousPath = router.currentRoute.value.fullPath
      const machine = account.machines.value.find(value => value.id === fleet.targetId)!
      const target = { teamId: machine.teamId, machineId: machine.id }
      // The shared fixture's Fleet store captured this target before injection.
      hostTarget.local = false
      fleet.localDesktopTarget = { ...previousDesktop, name: "Build machine", online: true, desktop: true }
      provide(platformClientKey, { ...host, platform: "darwin", mobile: false, target: { id: target.machineId, local: false }, ports: portFixture(target, args.populated) })
      provide(accountSessionKey, { ...account, machines: computed(() => [{ ...machine, name: "Build machine", online: true }]), localMachineId: computed(() => undefined) })
      onMounted(async () => {
        await router.replace({ name: "machine-control", params: { machineId: target.machineId }, query: { tab: "ports" } })
        ready.value = true
      })
      onScopeDispose(() => {
        hostTarget.local = previousLocal
        fleet.localDesktopTarget = previousDesktop
        void router.replace(previousPath)
      })
      return { ready, target }
    },
    template: `<main class="flex h-[720px] min-h-0 flex-col overflow-hidden rounded-xl border border-ui-border bg-ui-canvas">
      <RemoteControlView v-if="ready" :machine-id="target.machineId" />
    </main>`,
  }),
}
