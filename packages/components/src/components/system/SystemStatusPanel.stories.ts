import { getClient } from "@deskfleet/client/platform"
import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { provide } from "vue"
import type { SystemStatus } from "../../../../client/src/system.ts"
import { storybookSystemStatus } from "../../../.storybook/storybook-fixtures.ts"
import { platformClientKey } from "../../composables/usePlatformClient.ts"
import SystemStatusPanel from "./SystemStatusPanel.vue"

type Args = {
  machineName: string
  online: boolean
  active: boolean
  battery: SystemStatus["battery"]
  maxWidth: string
}

const meta = {
  title: "Features/Remote control/System status",
  args: {
    machineName: "Build server",
    online: true,
    active: true,
    battery: storybookSystemStatus.battery,
    maxWidth: "1000px",
  },
  parameters: { layout: "padded" },
  render: (args: Args) => ({
    components: { SystemStatusPanel },
    setup() {
      const status: SystemStatus = {
        ...storybookSystemStatus,
        battery: args.battery,
        sampledAt: Date.now(),
      }
      provide(platformClientKey, {
        ...getClient(),
        system: { status: async () => ({ ...status, sampledAt: Date.now() }) },
      })
      return { args }
    },
    template: `<div class="mx-auto w-full" :style="{ maxWidth: args.maxWidth }">
      <SystemStatusPanel machine-id="build-machine" :machine-name="args.machineName" :online="args.online" :active="args.active" />
    </div>`,
  }),
} satisfies Meta<Args>

export default meta
type Story = StoryObj<typeof meta>

export const Charging: Story = {}

export const WithoutBattery: Story = {
  args: { battery: undefined },
}

export const DischargingNarrow: Story = {
  args: { battery: { percent: 24.5, state: "discharging" }, machineName: "Laptop", maxWidth: "360px" },
}
