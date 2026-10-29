import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import type { TeamBilling } from "@deskfleet/client/billing"
import { HttpError } from "@deskfleet/client/http-central"
import { accountSessionKey, createAccountSession, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { fakeCentral, billingFixture } from "../../test/central.ts"
import TeamPlansUsage from "./TeamPlansUsage.vue"
import PlansUsageSettings from "../settings/PlansUsageSettings.vue"
import { trackEvent } from "../../services/analytics.ts"

vi.mock("../../services/analytics.ts", () => ({ trackEvent: vi.fn(), beginAnalyticsPlanRefresh: () => () => {} }))

let view: VueWrapper | undefined
let session: AccountSession | undefined
afterEach(() => { view?.unmount(); view = undefined; session?.dispose(); session = undefined; vi.clearAllMocks() })
const usage = () => view!.getComponent(TeamPlansUsage)
const metric = (key: string) => usage().get(`[data-team-usage="${key}"]`)

async function setup(configure?: (fake: ReturnType<typeof fakeCentral>) => void) {
  view?.unmount()
  session?.dispose()
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
  expect(usage().text()).toContain("The Team owner can upgrade this Team.")
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
  expect(usage().get("[data-billing-interval-option='month']").attributes("aria-pressed")).toBe("true")
  await button("Upgrade to Go")!.trigger("click"); await flushPromises()
  expect(usage().get('[role="alert"]').text()).toBe("Try checkout again")
  await button("Upgrade to Go")!.trigger("click"); await flushPromises()
  expect(fake.central.checkout).toHaveBeenCalledTimes(2)
  expect(fake.central.checkout.mock.calls[1]).toEqual(fake.central.checkout.mock.calls[0])
  expect(fake.central.checkout.mock.calls[0]).toEqual(["team-1", "go", expect.any(String), "month"])
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

test("annual billing creates a yearly checkout and keeps monthly request ids separate", async () => {
  const fake = await setup(fake => {
    fake.central.billing.mockResolvedValue({ ...free(), canManageBilling: true })
    fake.central.checkout.mockRejectedValue(new Error("Try checkout again"))
  })
  await usage().get("[data-billing-interval-option='year']").trigger("click")
  expect(usage().get("[data-billing-interval-option='year']").attributes("aria-pressed")).toBe("true")
  expect(usage().text()).toContain("Billed annually")
  await button("Upgrade to Go")!.trigger("click"); await flushPromises()
  expect(fake.central.checkout.mock.calls[0]).toEqual(["team-1", "go", expect.any(String), "year"])
  const yearlyId = fake.central.checkout.mock.calls[0]![2]
  await usage().get("[data-billing-interval-option='month']").trigger("click")
  await button("Upgrade to Go")!.trigger("click"); await flushPromises()
  expect(fake.central.checkout.mock.calls[1]).toEqual(["team-1", "go", expect.any(String), "month"])
  expect(fake.central.checkout.mock.calls[1]![2]).not.toBe(yearlyId)
})

test("configured Enterprise contact is offered without checkout", async () => {
  await setup(fake => fake.central.billing.mockResolvedValue({
    ...free(), canManageBilling: true, enterpriseContactEmail: "sales@example.test",
  }))
  const offer = usage().get('[data-billing-offer="enterprise"]')
  expect(offer.text()).toContain("Enterprise")
  expect(offer.get("a").attributes("href")).toBe("mailto:sales@example.test")
  expect(offer.get("a").text()).toContain("Contact us")
})

test("Enterprise contact does not replace the member upgrade hint", async () => {
  await setup(fake => fake.central.billing.mockResolvedValue({
    ...free(), enterpriseContactEmail: "sales@example.test",
  }))
  expect(usage().get('[data-billing-offer="enterprise"]').get("a").attributes("href")).toBe("mailto:sales@example.test")
  expect(usage().find("[data-billing-offer='go']").exists()).toBe(false)
  expect(usage().text()).toContain("The Team owner can upgrade this Team.")
})

test("Enterprise contact is hidden when unset or already granted", async () => {
  await setup(fake => fake.central.billing.mockResolvedValue({ ...free(), canManageBilling: true }))
  expect(usage().find('[data-billing-offer="enterprise"]').exists()).toBe(false)
  await setup(fake => fake.central.billing.mockResolvedValue({
    ...billingFixture(), plan: "enterprise", enterpriseOverride: true, paymentsAvailable: true, canManageBilling: true,
    enterpriseContactEmail: "sales@example.test",
  }))
  expect(usage().find('[data-billing-offer="enterprise"]').exists()).toBe(false)
  expect(usage().find("[data-billing-offer]").exists()).toBe(false)
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
  expect(trackEvent).toHaveBeenCalledWith("billing_payment_recovery_viewed", { subscription_status: "past_due" })
  expect(trackEvent).toHaveBeenCalledWith("billing_portal_started", { source: "payment_recovery" })
  expect(trackEvent).toHaveBeenCalledWith("billing_portal_opened_client", { source: "payment_recovery" })
})

test("plans are viewed once after loading and do not become a paid conversion on focus", async () => {
  await setup(fake => fake.central.billing.mockResolvedValue({ ...free(), canManageBilling: true }))
  expect(trackEvent).toHaveBeenCalledWith("billing_plans_viewed", {
    current_plan: "free", can_manage: true, payments_available: true, has_subscription: false, enterprise_contact_available: false,
  })
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect(vi.mocked(trackEvent).mock.calls.filter(([name]) => name === "billing_plans_viewed")).toHaveLength(1)
  expect(vi.mocked(trackEvent).mock.calls.map(([name]) => name)).not.toContain("billing_invoice_paid")
})

test("checkout funnel captures the selected interval and request identity, never a paid conversion", async () => {
  const opened = Promise.withResolvers<void>()
  const fake = await setup(fake => {
    fake.central.billing.mockResolvedValue({ ...free(), canManageBilling: true })
    fake.central.checkout.mockReturnValueOnce(opened.promise)
  })
  await usage().get("[data-billing-interval-option='year']").trigger("click")
  expect(trackEvent).toHaveBeenCalledWith("billing_interval_selected", { interval: "year", previous_interval: "month" })
  await button("Upgrade to Go")!.trigger("click")
  const metadata = { target_plan: "go", interval: "year", request_id: fake.central.checkout.mock.calls[0]![2] }
  expect(trackEvent).toHaveBeenCalledWith("billing_checkout_started", metadata)
  expect(trackEvent).not.toHaveBeenCalledWith("billing_checkout_opened", metadata)
  await usage().get("[data-billing-interval-option='month']").trigger("click")
  opened.resolve()
  await flushPromises()
  expect(trackEvent).toHaveBeenCalledWith("billing_checkout_opened", metadata)
  expect(vi.mocked(trackEvent).mock.calls.map(([name]) => name)).not.toContain("billing_invoice_paid")
})

test("checkout retries report bounded failure categories without exception text", async () => {
  const fake = await setup(fake => {
    fake.central.billing.mockResolvedValue({ ...free(), canManageBilling: true })
    fake.central.checkout.mockRejectedValueOnce(new HttpError(409, "private Stripe URL and customer info", undefined, "checkout_pending"))
  })
  await button("Upgrade to Pro")!.trigger("click"); await flushPromises()
  const metadata = { target_plan: "pro", interval: "month", request_id: fake.central.checkout.mock.calls[0]![2] }
  expect(trackEvent).toHaveBeenCalledWith("billing_checkout_failed", { ...metadata, reason: "checkout_pending" })
  await button("Upgrade to Pro")!.trigger("click"); await flushPromises()
  expect(trackEvent).toHaveBeenCalledWith("billing_checkout_opened", metadata)
  expect(JSON.stringify(vi.mocked(trackEvent).mock.calls)).not.toContain("private")
})

test("Enterprise contact records intent without the configured email", async () => {
  await setup(fake => fake.central.billing.mockResolvedValue({ ...free(), enterpriseContactEmail: "private@example.test" }))
  await usage().get('[data-billing-offer="enterprise"] a').trigger("click")
  expect(trackEvent).toHaveBeenCalledWith("billing_enterprise_contact_clicked", {})
  expect(JSON.stringify(vi.mocked(trackEvent).mock.calls)).not.toContain("private@example.test")
})

test("Portal failure is reported separately from opening a Portal", async () => {
  await setup(fake => {
    fake.central.billing.mockResolvedValue({ ...free(), canManageBilling: true, subscription: { plan: "go", status: "past_due", paidThrough: null, cancelAtPeriodEnd: false } })
    fake.central.billingPortal.mockRejectedValue(new Error("private opening failure"))
  })
  await button("Update payment")!.trigger("click"); await flushPromises()
  expect(trackEvent).toHaveBeenCalledWith("billing_portal_failed", { source: "payment_recovery", reason: "network_or_open_failed" })
  expect(trackEvent).not.toHaveBeenCalledWith("billing_portal_opened_client", expect.anything())
})

test("leaving settings still records a Checkout opening for the same account and Team", async () => {
  const opened = Promise.withResolvers<void>()
  await setup(fake => {
    fake.central.billing.mockResolvedValue({ ...free(), canManageBilling: true })
    fake.central.checkout.mockReturnValueOnce(opened.promise)
  })
  await button("Upgrade to Go")!.trigger("click")
  view!.unmount(); view = undefined
  opened.resolve()
  await flushPromises()
  expect(trackEvent).toHaveBeenCalledWith("billing_checkout_opened", expect.objectContaining({ target_plan: "go", interval: "month" }))
})

test("an earlier account's pending Checkout is not attributed to its replacement", async () => {
  const opened = Promise.withResolvers<void>()
  await setup(fake => {
    fake.central.billing.mockResolvedValue({ ...free(), canManageBilling: true })
    fake.central.checkout.mockReturnValueOnce(opened.promise)
  })
  await button("Upgrade to Go")!.trigger("click")
  session!.account.value = { ...session!.account.value, user: { ...session!.account.value.user!, id: "replacement-user" } }
  opened.resolve()
  await flushPromises()
  expect(trackEvent).not.toHaveBeenCalledWith("billing_checkout_opened", expect.anything())
})
