import type { NatTestResult, NetworkDiagnosticsApi } from "@deskfleet/client/network-diagnostics"
import { getClient } from "@deskfleet/client/platform"
import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { nextTick, provide } from "vue"
import { platformClientKey } from "../../composables/usePlatformClient.ts"
import { i18n } from "../../i18n/index.ts"
import DeveloperSettings from "./DeveloperSettings.vue"

const fullCone: NatTestResult = {
  server: "192.0.2.10:3478",
  localAddress: "192.168.1.5:50000",
  publicAddress: "203.0.113.5:60000",
  mapping: "endpoint-independent",
  filtering: "endpoint-independent",
  status: "complete",
  durationMs: 1200,
}

const meta = {
  title: "Features/Settings/DeveloperSettings",
  args: { api: { testNat: async () => fullCone } },
  render: args => ({
    components: { DeveloperSettings },
    setup() {
      provide(platformClientKey, { ...getClient(), networkDiagnostics: args.api })
      return {}
    },
    template: '<div class="mx-auto max-w-3xl"><DeveloperSettings /></div>',
  }),
} satisfies Meta<{ api: NetworkDiagnosticsApi | undefined }>
export default meta
type Story = StoryObj<typeof meta>

const runTest: Story["play"] = async ({ canvasElement }) => {
  canvasElement.querySelector("button")!.click()
  await nextTick()
}

export const Default: Story = {}
export const FullCone: Story = { play: runTest }
export const Symmetric: Story = {
  args: { api: { testNat: async () => ({ ...fullCone, mapping: "address-and-port-dependent", filtering: "address-and-port-dependent" }) } },
  play: runTest,
}
export const Testing: Story = { args: { api: { testNat: () => new Promise(() => {}) } }, play: runTest }
export const UnsupportedServer: Story = {
  args: { api: { testNat: async () => ({ ...fullCone, mapping: "unknown", filtering: "unknown", status: "server-unsupported" }) } },
  play: runTest,
}
export const Failed: Story = { args: { api: { testNat: async () => { throw new Error("STUN hostname could not be resolved") } } }, play: runTest }
export const NoStunServer: Story = {
  args: { api: { testNat: async () => { throw new Error(i18n.global.t("developerSettings.noStunServer")) } } },
  play: runTest,
}
export const Browser: Story = { args: { api: undefined } }
