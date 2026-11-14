import type { SiteUsagePeriod, SiteUsageTrends as UsageTrends } from "@deskfleet/client/site-usage"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { fakeCentral } from "../../test/central.ts"
import SiteUsageChart from "./SiteUsageChart.vue"
import SiteUsageTrends from "./SiteUsageTrends.vue"

let view: VueWrapper | undefined
afterEach(() => { view?.unmount(); view = undefined; i18n.global.locale.value = "en-US" })

function fixture(period: SiteUsagePeriod = "30d"): UsageTrends {
  return {
    period, timeZone: "UTC", from: "2026-10-16T00:00:00Z", to: "2026-11-14T12:00:00Z", generatedAt: "2026-11-14T12:00:00Z", relayHistoryIncomplete: false,
    totals: { users: 1_234, teams: 56, sessions: 789 },
    buckets: [
      { date: "2026-11-13", users: 1_200, teams: 54, sessions: 780, turnCount: 120, relayedBytes: "1073741824" },
      { date: "2026-11-14", users: 1_234, teams: 56, sessions: 789, turnCount: 30, relayedBytes: "536870912" },
    ],
  }
}

async function setup(configure?: (fake: ReturnType<typeof fakeCentral>) => void) {
  const fake = fakeCentral({ siteAdmin: true })
  fake.central.usageTrends.mockImplementation(async period => fixture(period))
  configure?.(fake)
  view = mount(SiteUsageTrends, { props: { api: fake.central }, global: { plugins: [i18n], stubs: { SiteUsageChart: true } } })
  await flushPromises()
  return fake
}
const value = (metric: string) => view!.get(`[data-site-usage-metric="${metric}"] [data-site-usage-value]`).text()
const selectPeriod = async (period: string) => { await view!.get(`[data-site-usage-period="${period}"]`).trigger("click"); await flushPromises() }

test("loads 30 days of global totals and period usage with five daily charts", async () => {
  const fake = await setup()
  expect(fake.central.usageTrends).toHaveBeenCalledExactlyOnceWith("30d")
  expect(value("users")).toBe("1,234")
  expect(value("teams")).toBe("56")
  expect(value("sessions")).toBe("789")
  expect(value("turnCount")).toBe("150")
  expect(value("relayedBytes")).toBe("1.5 GiB")
  expect(view!.text()).toContain("UTC")
  expect(view!.text()).toContain("Today is still in progress")
  const charts = view!.findAllComponents(SiteUsageChart)
  expect(charts.map(chart => chart.props("metric"))).toEqual(["users", "teams", "sessions", "turnCount", "relayedBytes"])
  expect(charts.every(chart => chart.props("buckets") === charts[0]!.props("buckets"))).toBe(true)
})

test("period changes discard a late response and refresh reloads the selected period", async () => {
  const fake = await setup()
  const old = Promise.withResolvers<UsageTrends>()
  fake.central.usageTrends.mockReturnValueOnce(old.promise)
  await selectPeriod("7d")
  expect(view!.get('[role="status"]').text()).toBe("Loading usage trends…")
  expect(view!.find("[data-site-usage-value]").exists()).toBe(false)
  await selectPeriod("90d")
  expect(fake.central.usageTrends).toHaveBeenLastCalledWith("90d")
  expect(view!.get('[data-site-usage-period="90d"]').attributes("aria-pressed")).toBe("true")
  old.resolve({ ...fixture("7d"), totals: { users: 99, teams: 3, sessions: 6 } })
  await flushPromises()
  expect(value("users")).toBe("1,234")
  await view!.get('[aria-label="Refresh usage trends"]').trigger("click")
  await flushPromises()
  expect(fake.central.usageTrends).toHaveBeenCalledTimes(4)
  expect(fake.central.usageTrends).toHaveBeenLastCalledWith("90d")
})

test("a failed request displays a retry and no fabricated zero totals", async () => {
  const fake = await setup(fake => fake.central.usageTrends.mockRejectedValueOnce(new Error("Offline")))
  expect(view!.get('[role="alert"]').text()).toBe("Could not load usage trends.")
  expect(view!.find("[data-site-usage-value]").exists()).toBe(false)
  await view!.findAll("button").find(button => button.text() === "Try again")!.trigger("click")
  await flushPromises()
  expect(fake.central.usageTrends).toHaveBeenCalledTimes(2)
  expect(value("users")).toBe("1,234")
})

test("recorded zeros remain visible and labels follow the Chinese locale", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  await setup(fake => fake.central.usageTrends.mockResolvedValue({ ...fixture(), totals: { users: 0, teams: 0, sessions: 0 }, buckets: [] }))
  expect(view!.get("h1").text()).toBe("用量趋势")
  expect(value("users")).toBe("0")
  expect(value("turnCount")).toBe("0")
  expect(value("relayedBytes")).toBe("0 B")
})

test("incomplete historical relay records are identified beside the charts", async () => {
  await setup(fake => fake.central.usageTrends.mockResolvedValue({ ...fixture(), relayHistoryIncomplete: true }))
  expect(view!.get("[data-site-usage-relay-incomplete]").text()).toBe("Some older relay data is not available yet.")
})
