import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import { accountSessionKey, createAccountSession, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { fakeCentral } from "../../test/central.ts"
import TeamPlansUsage from "./TeamPlansUsage.vue"
import TeamSettings from "./TeamSettings.vue"

let view: VueWrapper | undefined
let session: AccountSession | undefined
afterEach(() => { view?.unmount(); view = undefined; session?.dispose(); session = undefined })
const usage = () => view!.getComponent(TeamPlansUsage)

async function setup(configure?: (fake: ReturnType<typeof fakeCentral>) => void) {
  const fake = fakeCentral({ teams: [
    { id: "team-1", name: "Design team", role: "member" },
    { id: "team-2", name: "Engineering team", role: "member" },
  ] })
  configure?.(fake)
  session = createAccountSession(fake.central)
  await flushPromises()
  view = mount(TeamSettings, { global: { plugins: [i18n], provide: { [accountSessionKey as symbol]: session } } })
  await flushPromises()
  return fake
}

test.each([["0", "0 B"], ["1610612736", "1.5 GiB"]])("members see %s relayed bytes with an unlimited allowance", async (bytes, formatted) => {
  const fake = await setup(fake => fake.central.teamUsage.mockResolvedValue({ relayedBytes: bytes }))
  expect(fake.central.teamUsage).toHaveBeenCalledExactlyOnceWith("team-1")
  expect(usage().get("h2").text()).toBe("Plans & Usages")
  expect(usage().text()).toContain("Relayed traffic")
  expect(usage().text()).toContain("All time")
  expect(usage().text()).toContain("Unlimited")
  expect(usage().get("[data-team-usage-amount]").text()).toBe(`${formatted} / ∞`)
  const progress = usage().get('[role="progressbar"]')
  expect(progress.attributes("aria-valuetext")).toBe(`${formatted} used, unlimited allowance`)
  expect(progress.attributes("aria-valuenow")).toBeUndefined()
  expect(progress.attributes("aria-valuemax")).toBeUndefined()
})

test("failed usage requests can be retried without showing zero as the result", async () => {
  const fake = await setup(fake => fake.central.teamUsage
    .mockRejectedValueOnce(new Error("Network unavailable"))
    .mockResolvedValueOnce({ relayedBytes: "2048" }))
  expect(usage().get('[role="alert"]').text()).toBe("Could not load usage.")
  expect(usage().find("[data-team-usage-amount]").exists()).toBe(false)
  await usage().findAll("button").find(button => button.text() === "Retry")!.trigger("click")
  await flushPromises()
  expect(fake.central.teamUsage).toHaveBeenCalledTimes(2)
  expect(usage().find('[role="alert"]').exists()).toBe(false)
  expect(usage().get("[data-team-usage-amount]").text()).toBe("2.0 KiB / ∞")
})

test("switching teams clears the previous usage while the new request loads", async () => {
  const fake = await setup(fake => fake.central.teamUsage.mockResolvedValue({ relayedBytes: "1610612736" }))
  const next = Promise.withResolvers<{ relayedBytes: string }>()
  fake.central.teamUsage.mockReturnValueOnce(next.promise)
  await session!.selectTeam("team-2")
  await flushPromises()
  expect(fake.central.teamUsage).toHaveBeenLastCalledWith("team-2")
  expect(usage().get('[role="status"]').text()).toBe("Loading usage…")
  expect(usage().find("[data-team-usage-amount]").exists()).toBe(false)
  expect(usage().text()).not.toContain("1.5 GiB")
  next.resolve({ relayedBytes: "0" })
  await flushPromises()
  expect(usage().get("[data-team-usage-amount]").text()).toBe("0 B / ∞")
})

test("a late usage response from the previous team cannot replace the selected team's usage", async () => {
  const previous = Promise.withResolvers<{ relayedBytes: string }>()
  const fake = await setup(fake => fake.central.teamUsage.mockReturnValueOnce(previous.promise))
  fake.central.teamUsage.mockResolvedValueOnce({ relayedBytes: "2048" })
  await session!.selectTeam("team-2")
  await flushPromises()
  expect(usage().get("[data-team-usage-amount]").text()).toBe("2.0 KiB / ∞")
  previous.resolve({ relayedBytes: "1610612736" })
  await flushPromises()
  expect(usage().get("[data-team-usage-amount]").text()).toBe("2.0 KiB / ∞")
})
