import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { init } from "echarts/core"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { APPEARANCE_STORAGE_KEY, useAppearanceStore } from "../../stores/appearance.ts"
import SystemUsageChart from "./SystemUsageChart.vue"

const chart = vi.hoisted(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() }))
vi.mock("echarts/core", () => ({ use: vi.fn(), init: vi.fn(() => chart) }))
let resize: ResizeObserverCallback
let width = 640
let wrapper: VueWrapper | undefined
let pinia: ReturnType<typeof createPinia>
const sample = { time: Date.UTC(2026, 9, 26, 10), cpu: 42, memory: 50 }

beforeEach(() => {
  localStorage.removeItem(APPEARANCE_STORAGE_KEY)
  pinia = createPinia()
  setActivePinia(pinia)
  vi.clearAllMocks()
  width = 640
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width)
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(288)
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback }
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  disposePinia(pinia)
  localStorage.removeItem(APPEARANCE_STORAGE_KEY)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test("initializes only when active and sized, updates and resizes one chart, then disposes it", async () => {
  const warn = vi.fn()
  wrapper = mount(SystemUsageChart, { props: { samples: [sample], active: false }, global: { plugins: [i18n], config: { warnHandler: warn } } })
  await flushPromises()
  expect(init).not.toHaveBeenCalled()
  width = 0
  await wrapper.setProps({ active: true })
  expect(init).not.toHaveBeenCalled()

  width = 640
  resize([], {} as ResizeObserver)
  expect(init).toHaveBeenCalledExactlyOnceWith(wrapper.element, undefined, { renderer: "svg" })
  expect(chart.setOption).toHaveBeenCalledOnce()
  expect(chart.resize).toHaveBeenCalledOnce()
  expect(warn).not.toHaveBeenCalled()

  await wrapper.setProps({ samples: [sample, { ...sample, time: sample.time + 2_000, cpu: 65 }] })
  expect(chart.setOption.mock.lastCall![0].series[0].data).toEqual([[sample.time, 42], [sample.time + 2_000, 65]])
  const updates = chart.setOption.mock.calls.length
  await wrapper.setProps({ active: false })
  resize([], {} as ResizeObserver)
  expect(chart.setOption).toHaveBeenCalledTimes(updates)

  await wrapper.setProps({ active: true })
  expect(chart.setOption).toHaveBeenCalledTimes(updates + 1)
  expect(init).toHaveBeenCalledOnce()
  wrapper.unmount()
  wrapper = undefined
  expect(chart.dispose).toHaveBeenCalledOnce()
})

test("passes missing observation intervals as gaps instead of joining them into a load trend", async () => {
  const next = { ...sample, time: sample.time + 10_000, cpu: 75, memory: 60 }
  wrapper = mount(SystemUsageChart, { props: { samples: [sample, next], active: true }, global: { plugins: [i18n] } })
  await flushPromises()
  const option = chart.setOption.mock.lastCall![0]
  expect(option.xAxis.min).toBe(next.time - 60_000)
  expect(option.xAxis.max).toBe(next.time)
  expect(option.series[0].data).toEqual([[sample.time, 42], [sample.time + 1, null], [next.time, 75]])
  expect(option.series[1].data).toEqual([[sample.time, 50], [sample.time + 1, null], [next.time, 60]])
})

test("redraws an existing chart when the selected theme or interface font changes", async () => {
  const appearance = useAppearanceStore()
  appearance.settings.theme = "light"
  wrapper = mount(SystemUsageChart, { attachTo: document.body, props: { samples: [sample], active: true }, global: { plugins: [i18n] } })
  await flushPromises()
  chart.setOption.mockClear()

  appearance.settings.theme = "dark"
  await flushPromises()
  expect(chart.setOption).toHaveBeenCalledOnce()

  const font = "Arial, sans-serif"
  ;(wrapper.element as HTMLElement).style.fontFamily = font
  appearance.settings.interfaceFont = font
  await flushPromises()
  expect(chart.setOption).toHaveBeenCalledTimes(2)
  expect(chart.setOption.mock.lastCall![0].textStyle.fontFamily).toBe(font)
  expect(init).toHaveBeenCalledOnce()
})
