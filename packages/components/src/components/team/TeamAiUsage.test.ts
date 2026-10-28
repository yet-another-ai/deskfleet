import type { TeamAiUsage, TeamAiUsageSessions } from "@deskfleet/client/ai-usage"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import { accountSessionKey, createAccountSession, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { aiUsageFixture, fakeCentral } from "../../test/central.ts"
import AiUsageSettings from "../settings/AiUsageSettings.vue"

let view: VueWrapper | undefined
let session: AccountSession | undefined
afterEach(() => {
  view?.unmount(); view = undefined
  session?.dispose(); session = undefined
  i18n.global.locale.value = "en-US"
})

function fixture(totalTokens = 1_250): TeamAiUsage {
  return {
    ...aiUsageFixture(), lastSyncedAt: "2026-10-28T12:00:00Z",
    totals: { totalTokens, inputTokens: 1_000, outputTokens: 250, cachedReadTokens: 500, cachedWriteTokens: null, thoughtTokens: null, reportedTurnCount: 2, turnCount: 3 },
    buckets: [
      { start: "2026-10-27T00:00:00Z", totalTokens: 1_000, turnCount: 1, reportedTurnCount: 1, models: { codex: 1_000 }, members: { ada: 1_000 } },
      { start: "2026-10-28T00:00:00Z", totalTokens: 250, turnCount: 2, reportedTurnCount: 1, models: { unknown: 250 }, members: { unknown: 250 } },
    ],
    heatmap: [
      { date: "2026-10-26", totalTokens: 0, turnCount: 0, reportedTurnCount: 0 },
      { date: "2026-10-27", totalTokens: 1_000, turnCount: 1, reportedTurnCount: 1 },
      { date: "2026-10-28", totalTokens: 250, turnCount: 2, reportedTurnCount: 1 },
    ],
    models: [
      { id: "codex", name: "GPT Codex", totalTokens: 1_000, turnCount: 1, reportedTurnCount: 1 },
      { id: "unknown", name: "unknown", totalTokens: 250, turnCount: 2, reportedTurnCount: 1 },
    ],
    members: [
      { id: "ada", name: "Ada", totalTokens: 1_000, turnCount: 1, reportedTurnCount: 1 },
      { id: "unknown", name: "unknown", totalTokens: 250, turnCount: 2, reportedTurnCount: 1 },
    ],
  }
}

async function setup(configure?: (fake: ReturnType<typeof fakeCentral>) => void) {
  const fake = fakeCentral({ teams: [
    { id: "team-1", name: "Design team", role: "member" },
    { id: "team-2", name: "Engineering team", role: "member" },
  ] })
  fake.central.aiUsage.mockResolvedValue(fixture())
  configure?.(fake)
  session = createAccountSession(fake.central)
  await flushPromises()
  view = mount(AiUsageSettings, { global: {
    plugins: [i18n], stubs: { AiUsageChart: true }, provide: { [accountSessionKey as symbol]: session },
  } })
  await flushPromises()
  return fake
}
const total = () => view!.get("[data-ai-usage-total]").text()
const period = async (value: string) => { await view!.get(`[data-usage-period="${value}"]`).trigger("click"); await flushPromises() }
const retry = async () => { await view!.findAll("button").find(button => button.text() === "Retry")!.trigger("click"); await flushPromises() }

test("defaults to 30 days in the browser timezone, with real totals, coverage and unknown groups", async () => {
  const fake = await setup()
  expect(fake.central.aiUsage).toHaveBeenCalledExactlyOnceWith("team-1", { period: "30d", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  expect(total()).toBe("1.3K")
  expect(view!.text()).toContain("Usage reported for 2 of 3 turns")
  expect(view!.text()).toContain("Unknown model")
  expect(view!.text()).toContain("Unknown member")
  expect(view!.get('[data-ai-usage-metric="cachedRead"]').text()).toContain("500")
  expect(view!.get('[data-ai-usage-metric="cachedWrite"]').text()).toContain("—")
  expect(view!.get('[data-usage-period="30d"]').attributes("aria-pressed")).toBe("true")
})

test("period changes refetch and a late result cannot replace the current period", async () => {
  const fake = await setup()
  const old = Promise.withResolvers<TeamAiUsage>()
  fake.central.aiUsage.mockReturnValueOnce(old.promise)
  await period("7d")
  expect(view!.get('[role="status"]').text()).toBe("Loading usage…")
  expect(view!.find("[data-ai-usage-total]").exists()).toBe(false)
  fake.central.aiUsage.mockResolvedValueOnce({ ...fixture(9_000), period: "24h" })
  await period("24h")
  expect(fake.central.aiUsage).toHaveBeenLastCalledWith("team-1", expect.objectContaining({ period: "24h" }))
  expect(total()).toBe("9K")
  old.resolve({ ...fixture(77_000), period: "7d" })
  await flushPromises()
  expect(total()).toBe("9K")
  expect(view!.text()).toContain("Hourly average")
  await period("all")
  expect(fake.central.aiUsage).toHaveBeenLastCalledWith("team-1", expect.objectContaining({ period: "all" }))
})

test("failed requests show retry without a fabricated zero", async () => {
  const fake = await setup(fake => fake.central.aiUsage.mockRejectedValueOnce(new Error("Offline")))
  expect(view!.get('[role="alert"]').text()).toBe("Could not load usage.")
  expect(view!.find("[data-ai-usage-total]").exists()).toBe(false)
  await retry()
  expect(fake.central.aiUsage).toHaveBeenCalledTimes(2)
  expect(total()).toBe("1.3K")
})

test("24-hour view divides its token total by elapsed hours including partial boundary buckets", async () => {
  await setup(fake => fake.central.aiUsage.mockImplementation(async (_teamId, query) => ({
    ...fixture(240), ...query, from: "2026-10-27T12:30:00Z", to: "2026-10-28T12:30:00Z",
    buckets: Array.from({ length: 25 }, (_, index) => ({
      start: new Date(Date.UTC(2026, 9, 27, 12 + index)).toISOString(),
      totalTokens: index === 0 || index === 24 ? 5 : 10,
      turnCount: 1, reportedTurnCount: 1, models: {}, members: {},
    })),
  })))
  await period("24h")
  const average = view!.findAll("dl > div").find(item => item.get("dt").text() === "Hourly average")!
  expect(average.get("dd").text()).toBe("10")
})

test.each([0, 4])("%s unreported turns show unknown totals and a specific empty state", async turnCount => {
  await setup(fake => {
    const value = aiUsageFixture()
    value.totals.turnCount = turnCount
    fake.central.aiUsage.mockResolvedValue(value)
  })
  expect(total()).toBe("—")
  expect(view!.get("[data-ai-usage-empty]").text()).toContain(turnCount ? "no reported token usage" : "No turns")
  expect(view!.find("[data-ai-usage-breakdown]").exists()).toBe(false)
})

test("an explicitly reported zero stays zero", async () => {
  await setup(fake => {
    const value = fixture(0)
    value.totals.inputTokens = 0
    value.totals.outputTokens = 0
    fake.central.aiUsage.mockResolvedValue(value)
  })
  expect(total()).toBe("0")
  expect(view!.find("[data-ai-usage-empty]").exists()).toBe(false)
})

test("team changes clear data and late previous-team requests cannot replace the new team", async () => {
  const previous = Promise.withResolvers<TeamAiUsage>()
  const fake = await setup(fake => fake.central.aiUsage.mockReturnValueOnce(previous.promise))
  const next = Promise.withResolvers<TeamAiUsage>()
  fake.central.aiUsage.mockReturnValueOnce(next.promise)
  await session!.selectTeam("team-2")
  await flushPromises()
  expect(view!.text()).toContain("Engineering team")
  expect(view!.find("[data-ai-usage-total]").exists()).toBe(false)
  next.resolve(fixture(8_000)); await flushPromises()
  previous.resolve(fixture(99_000)); await flushPromises()
  expect(fake.central.aiUsage).toHaveBeenLastCalledWith("team-2", expect.anything())
  expect(total()).toBe("8K")
})

test("clicking a day loads sessions, handles missing tokens, and ignores a late previous day", async () => {
  const fake = await setup()
  const previous = Promise.withResolvers<TeamAiUsageSessions>()
  fake.central.aiUsageSessions.mockReturnValueOnce(previous.promise)
  await view!.get('[data-usage-date="2026-10-27"]').trigger("click")
  await flushPromises()
  fake.central.aiUsageSessions.mockResolvedValueOnce({
    date: "2026-10-28", timeZone: "UTC", truncated: false,
    sessions: [{ ...fixture().totals, machineId: "machine-1", machineName: "Build Mac", sessionId: "s-2", title: "Fix calendar", totalTokens: 0, reportedTurnCount: 0 }],
  })
  await view!.get('[data-usage-date="2026-10-28"]').trigger("click")
  await flushPromises()
  expect(fake.central.aiUsageSessions).toHaveBeenLastCalledWith("team-1", { date: "2026-10-28", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  const detail = () => view!.get("[data-ai-usage-detail]").text()
  expect(detail()).toContain("Fix calendar")
  expect(detail()).toContain("Build Mac")
  expect(detail()).toContain("Not reported")
  previous.resolve({ date: "2026-10-27", timeZone: "UTC", sessions: [], truncated: false })
  await flushPromises()
  expect(detail()).toContain("Fix calendar")
  await period("7d")
  expect(view!.find("[data-ai-usage-detail]").exists()).toBe(false)
})

test("day detail errors can retry and empty days remain selectable", async () => {
  const fake = await setup()
  fake.central.aiUsageSessions.mockRejectedValueOnce(new Error("Offline"))
  await view!.get('[data-usage-date="2026-10-26"]').trigger("click")
  await flushPromises()
  expect(view!.get("[data-ai-usage-detail]").get('[role="alert"]').text()).toBe("Could not load usage.")
  await retry()
  expect(view!.get("[data-ai-usage-detail]").text()).toContain("No sessions with turns on this day.")
})

test("Chinese labels and compact quantities follow the app locale", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  await setup(fake => fake.central.aiUsage.mockResolvedValue(fixture(120_000_000)))
  expect(view!.get("h1").text()).toBe("AI 用量")
  expect(total()).toBe("1.2亿")
  expect(view!.text()).toContain("未知模型")
  expect(view!.text()).toContain("未知成员")
})
