import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import SiteUsageChart from "./SiteUsageChart.vue"

const chart = vi.hoisted(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() }))
vi.mock("echarts/core", () => ({ use: vi.fn(), init: vi.fn(() => chart) }))
let view: VueWrapper | undefined
let pinia: ReturnType<typeof createPinia>
afterEach(() => { view?.unmount(); disposePinia(pinia); vi.restoreAllMocks(); vi.clearAllMocks() })

test("plots daily totals and relay byte values with UTC dates and suitable units", async () => {
  pinia = createPinia()
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(224)
  const buckets = [
    { date: "2026-11-13", users: 1_200, teams: 54, sessions: 780, turnCount: 120, relayedBytes: "0" },
    { date: "2026-11-14", users: 1_234, teams: 56, sessions: 789, turnCount: 30, relayedBytes: "1610612736" },
  ]
  view = mount(SiteUsageChart, { props: { buckets, metric: "users", label: "Total users" }, global: { plugins: [pinia, i18n] } })
  await flushPromises()
  const counts = chart.setOption.mock.lastCall![0]
  expect(counts.xAxis.data).toEqual(["2026-11-13", "2026-11-14"])
  expect(counts.xAxis.axisLabel.formatter("2026-11-13")).toBe("Nov 13")
  expect(counts.series[0].data).toEqual([1_200, 1_234])
  expect(counts.tooltip.valueFormatter(1_234)).toBe("1,234")
  await view.setProps({ metric: "relayedBytes", label: "Daily relay traffic" })
  const bytes = chart.setOption.mock.lastCall![0]
  expect(bytes.series[0].data).toEqual([0, 1_610_612_736])
  expect(bytes.tooltip.valueFormatter(1_610_612_736)).toBe("1.5 GiB")
  expect(bytes.yAxis.axisLabel.formatter(0)).toBe("0 B")
  expect(view.attributes("aria-label")).toBe("Daily relay traffic")
})
