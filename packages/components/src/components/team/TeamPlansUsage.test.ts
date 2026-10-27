import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import type { TeamBilling } from "@deskfleet/client/billing"
import { accountSessionKey, createAccountSession, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { fakeCentral, billingFixture } from "../../test/central.ts"
import TeamPlansUsage from "./TeamPlansUsage.vue"
import TeamSettings from "./TeamSettings.vue"

let view: VueWrapper | undefined
let session: AccountSession | undefined
afterEach(() => { view?.unmount(); view = undefined; session?.dispose(); session = undefined })
const usage = () => view!.getComponent(TeamPlansUsage)
const metric = (key: string) => usage().get(`[data-team-usage="${key}"]`)

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
  const fake = await setup(fake => fake.central.billing.mockResolvedValue(billingFixture({ relayedBytes: bytes, activeSessionCount: 0, memberCount: 1 })))
  expect(fake.central.billing).toHaveBeenCalledExactlyOnceWith("team-1")
  expect(usage().get("h2").text()).toBe("Plans & Usages")
  expect(metric("traffic").text()).toContain("Relayed traffic")
  expect(metric("traffic").text()).toContain("Current")
  expect(metric("traffic").text()).toContain("Unlimited")
  expect(metric("traffic").get("[data-team-usage-amount]").text()).toBe(`${formatted} / ∞`)
  const progress = metric("traffic").get('[role="progressbar"]')
  expect(progress.attributes("aria-valuetext")).toBe(`${formatted} / ∞`)
  expect(progress.attributes("aria-valuenow")).toBeUndefined()
  expect(progress.attributes("aria-valuemax")).toBeUndefined()
})

test.each([[0, 0], [8, 4]])("members see %s active sessions and %s team members with unlimited allowances", async (activeSessionCount, memberCount) => {
  await setup(fake => fake.central.billing.mockResolvedValue(billingFixture({ relayedBytes: "0", activeSessionCount, memberCount })))
  for (const [key, label, count] of [["sessions", "Active Sessions", activeSessionCount], ["members", "Team members", memberCount]] as const) {
    const card = metric(key)
    expect(card.get("h3").text()).toBe(label)
    expect(card.text()).toContain("Current")
    expect(card.text()).not.toContain("All time")
    expect(card.text()).toContain("Unlimited")
    expect(card.get("[data-team-usage-amount]").text()).toBe(`${count} / ∞`)
    const progress = card.get('[role="progressbar"]')
    expect(progress.attributes("aria-valuetext")).toBe(`${count} / ∞`)
    expect(progress.attributes("aria-valuenow")).toBeUndefined()
    expect(progress.attributes("aria-valuemax")).toBeUndefined()
  }
})

test("failed usage requests can be retried without showing zero as the result", async () => {
  const fake = await setup(fake => fake.central.billing
    .mockRejectedValueOnce(new Error("Network unavailable"))
    .mockResolvedValueOnce(billingFixture({ relayedBytes: "2048", activeSessionCount: 3, memberCount: 2 })))
  expect(usage().get('[role="alert"]').text()).toBe("Could not load usage.")
  expect(usage().find("[data-team-usage-amount]").exists()).toBe(false)
  await usage().findAll("button").find(button => button.text() === "Retry")!.trigger("click")
  await flushPromises()
  expect(fake.central.billing).toHaveBeenCalledTimes(2)
  expect(usage().find('[role="alert"]').exists()).toBe(false)
  expect(metric("traffic").get("[data-team-usage-amount]").text()).toBe("2.0 KiB / ∞")
  expect(metric("sessions").get("[data-team-usage-amount]").text()).toBe("3 / ∞")
  expect(metric("members").get("[data-team-usage-amount]").text()).toBe("2 / ∞")
})

test("switching teams clears the previous usage while the new request loads", async () => {
  const fake = await setup(fake => fake.central.billing.mockResolvedValue(billingFixture({ relayedBytes: "1610612736", activeSessionCount: 8, memberCount: 4 })))
  const next = Promise.withResolvers<TeamBilling>()
  fake.central.billing.mockReturnValueOnce(next.promise)
  await session!.selectTeam("team-2")
  await flushPromises()
  expect(fake.central.billing).toHaveBeenLastCalledWith("team-2")
  expect(usage().get('[role="status"]').text()).toBe("Loading usage…")
  expect(usage().find("[data-team-usage-amount]").exists()).toBe(false)
  expect(usage().text()).not.toContain("1.5 GiB")
  expect(usage().text()).not.toContain("8 / ∞")
  expect(usage().text()).not.toContain("4 / ∞")
  next.resolve(billingFixture({ relayedBytes: "0", activeSessionCount: 0, memberCount: 1 }))
  await flushPromises()
  expect(metric("traffic").get("[data-team-usage-amount]").text()).toBe("0 B / ∞")
  expect(metric("sessions").get("[data-team-usage-amount]").text()).toBe("0 / ∞")
  expect(metric("members").get("[data-team-usage-amount]").text()).toBe("1 / ∞")
})

test("a late usage response from the previous team cannot replace the selected team's usage", async () => {
  const previous = Promise.withResolvers<TeamBilling>()
  const fake = await setup(fake => fake.central.billing.mockReturnValueOnce(previous.promise))
  fake.central.billing.mockResolvedValueOnce(billingFixture({ relayedBytes: "2048", activeSessionCount: 3, memberCount: 2 }))
  await session!.selectTeam("team-2")
  await flushPromises()
  expect(metric("traffic").get("[data-team-usage-amount]").text()).toBe("2.0 KiB / ∞")
  expect(metric("sessions").get("[data-team-usage-amount]").text()).toBe("3 / ∞")
  expect(metric("members").get("[data-team-usage-amount]").text()).toBe("2 / ∞")
  previous.resolve(billingFixture({ relayedBytes: "1610612736", activeSessionCount: 8, memberCount: 4 }))
  await flushPromises()
  expect(metric("traffic").get("[data-team-usage-amount]").text()).toBe("2.0 KiB / ∞")
  expect(metric("sessions").get("[data-team-usage-amount]").text()).toBe("3 / ∞")
  expect(metric("members").get("[data-team-usage-amount]").text()).toBe("2 / ∞")
})


test("Free shows finite limits and does not expose billing actions to members", async () => {
  await setup(fake => fake.central.billing.mockResolvedValue({ ...billingFixture({ relayedBytes: "0", activeSessionCount: 3, memberCount: 3 }), plan: "free", limits: { maxActiveSessions: 3, maxTurnsPerSession: 30, maxMembers: 3, turnBytes: 0 }, paymentsAvailable: true }))
  expect(metric("sessions").get("[data-team-usage-amount]").text()).toBe("3 / 3")
  expect(metric("members").get("[data-team-usage-amount]").text()).toBe("3 / 3")
  expect(metric("traffic").text()).toContain("Not included")
  expect(usage().text()).toContain("30 turns per Session")
  expect(usage().text()).not.toContain("Choose Go")
})

test("Team admins reuse a checkout request id when retrying", async () => {
  const fake = await setup(fake => {
    fake.central.billing.mockResolvedValue({ ...billingFixture(), plan: "free", paymentsAvailable: true, canManageBilling: true })
    fake.central.checkout.mockRejectedValue(new Error("Try checkout again"))
  })
  const go = usage().findAll("button").find(button => button.text().includes("Choose Go"))!
  await go.trigger("click"); await flushPromises()
  await go.trigger("click"); await flushPromises()
  expect(fake.central.checkout).toHaveBeenCalledTimes(2)
  expect(fake.central.checkout.mock.calls[1]).toEqual(fake.central.checkout.mock.calls[0])
})
