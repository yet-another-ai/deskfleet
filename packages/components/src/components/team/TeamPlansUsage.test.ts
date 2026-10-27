import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import type { TeamBilling } from "@deskfleet/client/billing"
import { HttpError } from "@deskfleet/client/http-central"
import { accountSessionKey, createAccountSession, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { fakeCentral, billingFixture } from "../../test/central.ts"
import TeamPlansUsage from "./TeamPlansUsage.vue"
import PlansUsageSettings from "../settings/PlansUsageSettings.vue"

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
  view = mount(PlansUsageSettings, { global: { plugins: [i18n], provide: { [accountSessionKey as symbol]: session } } })
  await flushPromises()
  return fake
}

const free = (usage = { relayedBytes: "0", activeSessionCount: 3, memberCount: 3 }): TeamBilling => ({
  ...billingFixture(usage), plan: "free", limits: { maxActiveSessions: 3, maxTurnsPerSession: 30, maxMembers: 3, turnBytes: 0 }, paymentsAvailable: true,
})
const button = (label: string) => usage().findAll("button").find(value => value.text() === label)

test.each([["0", "0 B"], ["1610612736", "1.5 GiB"]])("unlimited relay shows %s used without a bar that reads as a limit", async (bytes, formatted) => {
  const fake = await setup(fake => fake.central.billing.mockResolvedValue(billingFixture({ relayedBytes: bytes, activeSessionCount: 0, memberCount: 1 })))
  expect(fake.central.billing).toHaveBeenCalledExactlyOnceWith("team-1")
  expect(usage().get("h1").text()).toBe("Plans & Usages")
  expect(usage().get("[data-team-plan]").text()).toContain("Self-hosted")
  expect(metric("traffic").get("h3").text()).toBe("Relayed traffic")
  expect(metric("traffic").get("[data-team-usage-amount]").text()).toBe(formatted)
  expect(metric("traffic").text()).toContain("Unlimited")
  expect(metric("traffic").find('[role="progressbar"]').exists()).toBe(false)
})

test.each([[0, 0], [8, 4]])("%s active sessions and %s members are counts against unlimited allowances", async (activeSessionCount, memberCount) => {
  await setup(fake => fake.central.billing.mockResolvedValue(billingFixture({ relayedBytes: "0", activeSessionCount, memberCount })))
  for (const [key, label, count] of [["sessions", "Active Sessions", activeSessionCount], ["members", "Team members", memberCount]] as const) {
    expect(metric(key).get("h3").text()).toBe(label)
    expect(metric(key).get("[data-team-usage-amount]").text()).toBe(String(count))
    expect(metric(key).text()).toContain("Unlimited")
    expect(metric(key).find('[role="progressbar"]').exists()).toBe(false)
  }
  expect(metric("turns").text()).toContain("Unlimited")
})

test("failed usage requests can be retried without showing zero as the result", async () => {
  const fake = await setup(fake => fake.central.billing
    .mockRejectedValueOnce(new Error("Network unavailable"))
    .mockResolvedValueOnce(billingFixture({ relayedBytes: "2048", activeSessionCount: 3, memberCount: 2 })))
  expect(usage().get('[role="alert"]').text()).toBe("Could not load usage.")
  expect(usage().find("[data-team-usage-amount]").exists()).toBe(false)
  await button("Retry")!.trigger("click")
  await flushPromises()
  expect(fake.central.billing).toHaveBeenCalledTimes(2)
  expect(usage().find('[role="alert"]').exists()).toBe(false)
  expect(metric("traffic").get("[data-team-usage-amount]").text()).toBe("2.0 KiB")
  expect(metric("sessions").get("[data-team-usage-amount]").text()).toBe("3")
  expect(metric("members").get("[data-team-usage-amount]").text()).toBe("2")
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
  next.resolve(billingFixture({ relayedBytes: "0", activeSessionCount: 0, memberCount: 1 }))
  await flushPromises()
  expect(metric("traffic").get("[data-team-usage-amount]").text()).toBe("0 B")
  expect(metric("members").get("[data-team-usage-amount]").text()).toBe("1")
})

test("a late usage response from the previous team cannot replace the selected team's usage", async () => {
  const previous = Promise.withResolvers<TeamBilling>()
  const fake = await setup(fake => fake.central.billing.mockReturnValueOnce(previous.promise))
  fake.central.billing.mockResolvedValueOnce(billingFixture({ relayedBytes: "2048", activeSessionCount: 3, memberCount: 2 }))
  await session!.selectTeam("team-2")
  await flushPromises()
  expect(metric("traffic").get("[data-team-usage-amount]").text()).toBe("2.0 KiB")
  previous.resolve(billingFixture({ relayedBytes: "1610612736", activeSessionCount: 8, memberCount: 4 }))
  await flushPromises()
  expect(metric("traffic").get("[data-team-usage-amount]").text()).toBe("2.0 KiB")
  expect(metric("sessions").get("[data-team-usage-amount]").text()).toBe("3")
})

test("Free shows finite limits, relay as not included, and no billing actions for members", async () => {
  await setup(fake => fake.central.billing.mockResolvedValue(free()))
  expect(metric("sessions").get("[data-team-usage-amount]").text()).toBe("3 / 3")
  expect(metric("sessions").get('[role="progressbar"]').attributes("aria-valuenow")).toBe("100")
  expect(metric("members").get("[data-team-usage-amount]").text()).toBe("3 / 3")
  expect(metric("traffic").text()).toContain("Not included")
  expect(metric("traffic").find("[data-team-usage-amount]").exists()).toBe(false)
  expect(metric("turns").text()).toContain("30 per Session")
  expect(usage().find("[data-billing-offer]").exists()).toBe(false)
  expect(usage().text()).toContain("A Team admin can upgrade this Team.")
})

test("metered relay shows the remaining allowance and next reset", async () => {
  await setup(fake => fake.central.billing.mockResolvedValue({
    ...billingFixture({ relayedBytes: String(1610612736), activeSessionCount: 1, memberCount: 1 }), plan: "go",
    limits: { maxActiveSessions: null, maxTurnsPerSession: null, maxMembers: null, turnBytes: 2147483648 }, nextResetAt: "2026-11-28T00:00:00Z",
  }))
  expect(metric("traffic").get("[data-team-usage-amount]").text()).toBe("1.5 GiB / 2.0 GiB")
  expect(metric("traffic").get('[role="progressbar"]').attributes("aria-valuenow")).toBe("75")
  expect(metric("traffic").text()).toContain("512 MiB left")
  expect(metric("traffic").text()).toContain("Resets")
})

test("Team admins choose an offer and reuse its checkout request id when retrying", async () => {
  const fake = await setup(fake => {
    fake.central.billing.mockResolvedValue({ ...free(), canManageBilling: true })
    fake.central.checkout.mockRejectedValue(new Error("Try checkout again"))
  })
  expect(usage().findAll("[data-billing-offer]").map(offer => offer.attributes("data-billing-offer"))).toEqual(["go", "pro"])
  await button("Upgrade to Go")!.trigger("click"); await flushPromises()
  expect(usage().get('[role="alert"]').text()).toBe("Try checkout again")
  await button("Upgrade to Go")!.trigger("click"); await flushPromises()
  expect(fake.central.checkout).toHaveBeenCalledTimes(2)
  expect(fake.central.checkout.mock.calls[1]).toEqual(fake.central.checkout.mock.calls[0])
})

test.each([false, true])("returning to an earlier offer creates a new checkout after its replacement (first result uncertain: %s)", async uncertain => {
  const fake = await setup(fake => {
    fake.central.billing.mockResolvedValue({ ...free(), canManageBilling: true })
    if (uncertain) fake.central.checkout.mockRejectedValueOnce(new Error("Response lost"))
  })
  for (const label of ["Upgrade to Go", "Upgrade to Pro", "Upgrade to Go"]) {
    await button(label)!.trigger("click"); await flushPromises()
  }
  const calls = fake.central.checkout.mock.calls
  expect(calls.map(call => call.slice(0, 2))).toEqual([["team-1", "go"], ["team-1", "pro"], ["team-1", "go"]])
  expect(calls[2]![2]).not.toBe(calls[0]![2])
})

test("an explicitly finished checkout gets a new request id on the next attempt", async () => {
  const fake = await setup(fake => {
    fake.central.billing.mockResolvedValue({ ...free(), canManageBilling: true })
    fake.central.checkout
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockRejectedValueOnce(new HttpError(409, "Start a new checkout request", undefined, "checkout_finished"))
  })
  for (let attempt = 0; attempt < 3; attempt++) {
    await button("Upgrade to Go")!.trigger("click"); await flushPromises()
  }
  const calls = fake.central.checkout.mock.calls
  expect(calls[1]).toEqual(calls[0])
  expect(calls[2]![2]).not.toBe(calls[1]![2])
})

test("a failed renewal offers billing admins the payment recovery action", async () => {
  const fake = await setup(fake => fake.central.billing.mockResolvedValue({
    ...billingFixture(), plan: "go", paymentsAvailable: true, canManageBilling: true,
    limits: { maxActiveSessions: null, maxTurnsPerSession: null, maxMembers: null, turnBytes: 2147483648 },
    subscription: { plan: "go", status: "past_due", paidThrough: "2026-11-01T00:00:00Z", cancelAtPeriodEnd: false },
  }))
  expect(usage().get("[data-team-plan]").text()).toContain("Payment issue")
  expect(usage().find("[data-billing-offer]").exists()).toBe(false)
  await button("Update payment")!.trigger("click"); await flushPromises()
  expect(fake.central.billingPortal).toHaveBeenCalledExactlyOnceWith("team-1")
})
