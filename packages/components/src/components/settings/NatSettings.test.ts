import type { NatTestResult, NetworkDiagnosticsApi } from "@deskfleet/client/network-diagnostics"
import { getClient } from "@deskfleet/client/platform"
import { flushPromises, mount, RouterLinkStub, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { platformClientKey } from "../../composables/usePlatformClient.ts"
import { i18n } from "../../i18n/index.ts"
import NatSettings from "./NatSettings.vue"

const fullCone: NatTestResult = {
  server: "192.0.2.10:3478",
  localAddress: "192.168.1.5:50000",
  publicAddress: "203.0.113.5:60000",
  mapping: "endpoint-independent",
  filtering: "endpoint-independent",
  status: "complete",
  durationMs: 1200,
}
let view: VueWrapper | undefined

function render(api?: NetworkDiagnosticsApi) {
  view = mount(NatSettings, {
    global: {
      plugins: [i18n],
      stubs: { RouterLink: RouterLinkStub },
      provide: { [platformClientKey as symbol]: { ...getClient(), networkDiagnostics: api } },
    },
  })
  return view
}

async function submit(wrapper: VueWrapper) {
  await wrapper.get("button").trigger("click")
  await flushPromises()
}

afterEach(() => {
  view?.unmount()
  view = undefined
  i18n.global.locale.value = "en-US"
})

test("starts only on click, uses the configured service, and prevents duplicate probes while running", async () => {
  let complete!: (value: NatTestResult) => void
  const testNat = vi.fn(() => new Promise<NatTestResult>(resolve => { complete = resolve }))
  const wrapper = render({ testNat })
  expect(testNat).not.toHaveBeenCalled()
  expect(wrapper.get("button").attributes("disabled")).toBeUndefined()
  expect(wrapper.find("input").exists()).toBe(false)
  await submit(wrapper)
  expect(testNat).toHaveBeenCalledExactlyOnceWith()
  expect(wrapper.get("button").attributes("disabled")).toBeDefined()
  expect(wrapper.get('[role="status"]').text()).toContain("35 seconds")
  await wrapper.get("button").trigger("click")
  expect(testNat).toHaveBeenCalledTimes(1)
  complete(fullCone)
  await flushPromises()
  expect(wrapper.get("h2").text()).toBe("Full-cone NAT")
  expect(wrapper.text()).toContain(fullCone.server)
  expect(wrapper.text()).toContain(fullCone.publicAddress)
  expect(wrapper.get("button").attributes("disabled")).toBeUndefined()
})

test("clears the previous result on retry and recovers after a failed probe", async () => {
  const testNat = vi.fn<NetworkDiagnosticsApi["testNat"]>().mockResolvedValueOnce(fullCone)
  const wrapper = render({ testNat })
  await submit(wrapper)
  expect(wrapper.find("h2").exists()).toBe(true)
  testNat.mockRejectedValueOnce(new Error("STUN hostname could not be resolved"))
  await wrapper.get("button").trigger("click")
  await flushPromises()
  expect(wrapper.find("h2").exists()).toBe(false)
  expect(wrapper.get('[role="alert"]').text()).toBe("STUN hostname could not be resolved")
  expect(wrapper.get("button").attributes("disabled")).toBeUndefined()
  testNat.mockResolvedValueOnce(fullCone)
  await wrapper.get("button").trigger("click")
  await flushPromises()
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(wrapper.get("h2").text()).toBe("Full-cone NAT")
})

test.each([
  ["direct", "endpoint-independent", "Open internet (no NAT)"],
  ["direct", "address-dependent", "UDP firewall (no NAT)"],
  ["endpoint-independent", "address-dependent", "Restricted-cone NAT"],
  ["endpoint-independent", "address-and-port-dependent", "Port-restricted-cone NAT"],
  ["address-dependent", "unknown", "Symmetric NAT"],
  ["address-and-port-dependent", "address-and-port-dependent", "Symmetric NAT"],
  ["endpoint-independent", "unknown", "Undetermined"],
  ["unknown", "endpoint-independent", "Undetermined"],
] as const)("summarizes %s mapping and %s filtering", async (mapping, filtering, label) => {
  const wrapper = render({ testNat: async () => ({ ...fullCone, mapping, filtering }) })
  await submit(wrapper)
  expect(wrapper.get("h2").text()).toBe(label)
})

test.each([
  ["server-unsupported", "does not support the required behavior discovery"],
  ["inconclusive", "Some probes could not be verified"],
  ["udp-unreachable", "This alone does not establish that UDP is blocked"],
] as const)("explains a %s result without inventing a NAT type", async (status, explanation) => {
  const wrapper = render({ testNat: async () => ({ ...fullCone, publicAddress: null, status, mapping: "unknown", filtering: "unknown" }) })
  await submit(wrapper)
  expect(wrapper.get("h2").text()).toBe("Undetermined")
  expect(wrapper.get('[role="status"]').text()).toContain(explanation)
  expect(wrapper.get('[role="status"]').text()).toContain("—")
})

test("shows the desktop requirement when the host has no native diagnostics", () => {
  const wrapper = render()
  expect(wrapper.text()).toContain("Browsers cannot perform the required UDP probes")
  expect(wrapper.find("button").exists()).toBe(false)
})

test.each([
  ["en-US", "NAT network type", "Full-cone NAT"],
  ["zh-cmn-Hans-CN", "NAT 网络类型", "完全锥形 NAT"],
  ["ja-JP", "NAT ネットワークタイプ", "フルコーン NAT"],
] as const)("localizes NAT diagnostics and results in %s", async (locale, title, resultLabel) => {
  i18n.global.locale.value = locale
  const wrapper = render({ testNat: async () => fullCone })
  await submit(wrapper)
  expect(wrapper.get("h1").text()).toBe(title)
  expect(wrapper.get("h2").text()).toBe(resultLabel)
  expect(wrapper.text()).not.toContain("developerSettings.")
})
