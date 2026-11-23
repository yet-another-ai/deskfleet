import { client as platformClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { defineComponent } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { SystemStatus } from "@deskfleet/client/system"
import { i18n } from "../../i18n/index.ts"
import { deferred } from "../../test/desktop-media.ts"
import SystemStatusPanel from "./SystemStatusPanel.vue"

const ChartStub = defineComponent({
  name: "SystemUsageChart", props: ["samples", "active"], template: '<div data-system-chart />',
})
const sample: SystemStatus = {
  sampledAt: Date.UTC(2026, 9, 26, 10), cpuUsagePercent: 42,
  memoryUsedBytes: 8 * 1024 ** 3, memoryTotalBytes: 16 * 1024 ** 3,
  swapUsedBytes: 512 * 1024 ** 2, swapTotalBytes: 2 * 1024 ** 3,
  cpuModel: "Remote machine CPU", logicalCpuCount: 8,
  os: "Linux 6.8", arch: "x86_64", uptimeSeconds: 90_061, daemonVersion: "2.3.4",
}
const originalSystem = platformClient.system
const wrappers: VueWrapper[] = []
const status = vi.fn<() => Promise<SystemStatus>>()
let visible = true

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
  vi.setSystemTime(sample.sampledAt)
  visible = true
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible ? "visible" : "hidden")
  status.mockReset().mockResolvedValue(sample)
  platformClient.system = { status }
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  platformClient.system = originalSystem
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function setup(props: Partial<{ machineId: string; machineName: string; online: boolean; active: boolean }> = {}) {
  const wrapper = mount(SystemStatusPanel, {
    props: { machineId: "remote-machine", machineName: "Build server", online: true, active: true, ...props },
    global: { plugins: [i18n], stubs: { SystemUsageChart: ChartStub } },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

async function tick(milliseconds = 2_000) {
  await vi.advanceTimersByTimeAsync(milliseconds)
  await flushPromises()
}

async function setVisible(value: boolean) {
  visible = value
  document.dispatchEvent(new Event("visibilitychange"))
  await flushPromises()
}

test("renders the target machine's measured usage, shared chart, and system details", async () => {
  const wrapper = await setup()
  expect(status).toHaveBeenCalledExactlyOnceWith()
  expect(wrapper.get('[data-system-metric="cpu"]').text()).toContain("42")
  expect(wrapper.get('[data-system-metric="memory"]').text()).toContain("50")
  expect(wrapper.get('[data-system-metric="swap"]').text()).toMatch(/512\s*MiB/)
  expect(wrapper.find('[data-system-metric="battery"]').exists()).toBe(false)
  expect(wrapper.text()).toContain("Remote machine CPU")
  expect(wrapper.text()).toContain("Linux 6.8")
  expect(wrapper.text()).toContain("x86_64")
  expect(wrapper.get("dl").text()).toContain("DeskFleet version2.3.4")
  expect(wrapper.findAll("[data-system-chart]")).toHaveLength(1)
  expect(wrapper.getComponent(ChartStub).props("samples")).toEqual([{ time: sample.sampledAt, cpu: 42, memory: 50 }])
  expect(wrapper.text()).not.toMatch(/every 2s|samples collected|latest sample/i)

  status.mockResolvedValue({ ...sample, sampledAt: sample.sampledAt + 2_000, cpuUsagePercent: 91 })
  await tick()
  expect(status).toHaveBeenCalledTimes(2)
  expect(wrapper.get('[data-system-metric="cpu"]').text()).toContain("91")
  expect(wrapper.getComponent(ChartStub).props("samples")).toEqual([
    { time: sample.sampledAt, cpu: 42, memory: 50 },
    { time: sample.sampledAt + 2_000, cpu: 91, memory: 50 },
  ])
})

test("renders remaining battery charge and charging state when available", async () => {
  status.mockResolvedValue({
    ...sample,
    battery: { percent: 87.6, state: "charging" },
  })
  const wrapper = await setup()
  const battery = wrapper.get('[data-system-metric="battery"]')
  expect(battery.text()).toContain("88")
  expect(battery.text()).toContain("Charging")
})

test("renders usage and timestamps with the application's Chinese locale", async () => {
  const previousLocale = i18n.global.locale.value
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  status.mockResolvedValue({
    ...sample,
    battery: { percent: 24.5, state: "discharging" },
  })
  try {
    const wrapper = await setup()
    expect(wrapper.get('[data-system-metric="cpu"]').text()).toContain("42")
    expect(wrapper.get('[data-system-metric="memory"]').text()).toContain("50")
    expect(wrapper.get('[data-system-metric="memory"]').text()).toContain("内存")
    expect(wrapper.get('[data-system-metric="swap"]').text()).toContain("交换空间")
    expect(wrapper.get('[data-system-metric="battery"]').text()).toContain("电池")
    expect(wrapper.get('[data-system-metric="battery"]').text()).toContain("使用电池")
    expect(wrapper.text()).not.toMatch(/每 2 秒|采样/)
    expect(wrapper.text()).toContain("1 天 1 小时 1 分钟")
    expect(wrapper.get("dl").text()).toContain("DeskFleet 版本2.3.4")
    status.mockRejectedValueOnce(new Error("Native collector failed"))
    await tick()
    const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(sample.sampledAt)
    expect(wrapper.get("[data-system-stale]").text()).toContain(time)
    expect(wrapper.text()).not.toContain("Native collector failed")
  } finally {
    i18n.global.locale.value = previousLocale
  }
})

test("polls only while the tab, document, and machine are available, then cleans up on unmount", async () => {
  const wrapper = await setup({ active: false })
  await tick(6_000)
  expect(status).not.toHaveBeenCalled()
  await wrapper.setProps({ active: true })
  await flushPromises()
  expect(status).toHaveBeenCalledTimes(1)
  await tick()
  expect(status).toHaveBeenCalledTimes(2)

  await wrapper.setProps({ active: false })
  await tick(6_000)
  expect(status).toHaveBeenCalledTimes(2)
  expect(wrapper.getComponent(ChartStub).props("active")).toBe(false)
  await wrapper.setProps({ active: true })
  await flushPromises()
  expect(status).toHaveBeenCalledTimes(3)
  await setVisible(false)
  await tick(6_000)
  expect(status).toHaveBeenCalledTimes(3)
  await setVisible(true)
  expect(status).toHaveBeenCalledTimes(4)

  await wrapper.setProps({ online: false })
  await tick(6_000)
  expect(status).toHaveBeenCalledTimes(4)
  expect(wrapper.text()).toMatch(/offline/i)
  await wrapper.setProps({ online: true })
  await flushPromises()
  expect(status).toHaveBeenCalledTimes(5)
  wrapper.unmount()
  wrappers.splice(wrappers.indexOf(wrapper), 1)
  await tick(6_000)
  expect(status).toHaveBeenCalledTimes(5)
})

test("slow reads do not overlap automatic or manual refresh", async () => {
  const pending = deferred<SystemStatus>()
  status.mockReturnValueOnce(pending.promise)
  const wrapper = await setup()
  await tick(8_000)
  await wrapper.get("[data-system-refresh]").trigger("click")
  expect(status).toHaveBeenCalledTimes(1)
  pending.resolve(sample)
  await flushPromises()
  await tick()
  expect(status).toHaveBeenCalledTimes(2)
})

test("failed refreshes retain and mark the last sample, then clear the error after recovery", async () => {
  const wrapper = await setup()
  status.mockRejectedValueOnce(new Error("Machine connection unavailable"))
  await tick()
  expect(wrapper.get('[data-system-metric="cpu"]').text()).toContain("42")
  expect(wrapper.get('[role="alert"]').text()).toContain(i18n.global.t("systemStatus.failed"))
  expect(wrapper.text()).not.toContain("Machine connection unavailable")
  expect(wrapper.find("[data-system-stale]").exists()).toBe(true)
  status.mockResolvedValue({ ...sample, sampledAt: sample.sampledAt + 4_000, cpuUsagePercent: 65 })
  await wrapper.get("[data-system-refresh]").trigger("click")
  await flushPromises()
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(wrapper.get('[data-system-metric="cpu"]').text()).toContain("65")
})

test("an initial failure presents a retry without displaying invented measurements", async () => {
  status.mockRejectedValueOnce(new Error("Metrics unavailable"))
  const wrapper = await setup()
  expect(wrapper.get('[role="alert"]').text()).toContain(i18n.global.t("systemStatus.failed"))
  expect(wrapper.text()).not.toContain("Metrics unavailable")
  expect(wrapper.find('[data-system-metric="cpu"]').exists()).toBe(false)
  await wrapper.get("[data-system-refresh]").trigger("click")
  await flushPromises()
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(wrapper.get('[data-system-metric="cpu"]').text()).toContain("42")
})

test.each(["hidden", "offline"])("ignores an in-flight response after becoming %s", async state => {
  const pending = deferred<SystemStatus>()
  status.mockReturnValueOnce(pending.promise)
  const wrapper = await setup()
  if (state === "hidden") await wrapper.setProps({ active: false })
  else await wrapper.setProps({ online: false })
  pending.resolve({ ...sample, cpuUsagePercent: 97 })
  await flushPromises()
  expect(wrapper.find('[data-system-metric="cpu"]').exists()).toBe(false)
  await wrapper.setProps({ active: true, online: true })
  await flushPromises()
  expect(wrapper.get('[data-system-metric="cpu"]').text()).toContain("42")
})

test("changing machines clears existing measurements and rejects the old machine's pending read", async () => {
  const wrapper = await setup()
  const old = deferred<SystemStatus>()
  const next = deferred<SystemStatus>()
  status.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
  await tick()
  await wrapper.setProps({ machineId: "another-machine", machineName: "Other server" })
  expect(wrapper.find('[data-system-metric="cpu"]').exists()).toBe(false)
  old.resolve({ ...sample, cpuUsagePercent: 97 })
  await flushPromises()
  await tick()
  expect(wrapper.find('[data-system-metric="cpu"]').exists()).toBe(false)
  next.resolve({ ...sample, cpuUsagePercent: 12, cpuModel: "Other CPU" })
  await flushPromises()
  expect(wrapper.get('[data-system-metric="cpu"]').text()).toContain("12")
  expect(wrapper.text()).toContain("Other CPU")
  expect(wrapper.text()).not.toContain("Remote machine CPU")
})

test("an unavailable adapter or offline machine never requests metrics", async () => {
  platformClient.system = undefined
  const unavailable = await setup()
  expect(unavailable.text()).toMatch(/unavailable/i)
  expect(status).not.toHaveBeenCalled()
  platformClient.system = { status }
  const offline = await setup({ online: false })
  await tick(6_000)
  expect(offline.text()).toMatch(/offline/i)
  expect(status).not.toHaveBeenCalled()
})
