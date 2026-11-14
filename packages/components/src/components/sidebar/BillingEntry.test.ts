import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { computed, ref } from "vue"
import { afterEach, expect, test, vi } from "vitest"
import type { TeamBilling } from "@deskfleet/client/billing"
import { accountSessionKey, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { billingFixture, fakeCentral } from "../../test/central.ts"
import { trackEvent } from "../../services/analytics.ts"
import BillingEntry from "./BillingEntry.vue"

vi.mock("../../services/analytics.ts", () => ({ trackEvent: vi.fn() }))
let wrapper: VueWrapper
const free = { ...billingFixture(), plan: "free" as const, paymentsAvailable: true, canManageBilling: true }
function setup(value: TeamBilling = free) {
  const { central } = fakeCentral()
  central.billing.mockResolvedValue(value)
  const team = ref({ id: "team-1", name: "Design", role: "owner" as const })
  const account = { team, teamId: computed(() => team.value.id), account: ref({ user: { id: "user-1" } }), central, openSettings: vi.fn() } as unknown as AccountSession
  const render = () => mount(BillingEntry, { global: { plugins: [i18n], provide: { [accountSessionKey as symbol]: account } } })
  wrapper = render()
  return { account, central, team, render }
}
afterEach(() => { wrapper?.unmount(); vi.clearAllMocks(); vi.unstubAllGlobals() })

test("free owner reaches plans without a machine", async () => {
  const { account } = setup()
  await flushPromises()
  expect(wrapper.text()).toContain("Upgrade plan")
  expect(trackEvent).not.toHaveBeenCalled()
  await wrapper.get("button").trigger("click")
  expect(account.openSettings).toHaveBeenCalledWith("plans")
  expect(trackEvent).toHaveBeenCalledWith("billing_entry_clicked", { source: "sidebar", current_plan: "free", action: "upgrade" })
})

test.each([
  { plan: "go" as const }, { plan: "selfHosted" as const }, { canManageBilling: false },
  { paymentsAvailable: false }, { manualGrant: { plan: "free" as const, expiresAt: null } },
  { subscription: { plan: "go" as const, status: "past_due", paidThrough: null, cancelAtPeriodEnd: false } },
])("offers neutral billing navigation for %j", async override => {
  setup({ ...free, ...override })
  await flushPromises()
  expect(wrapper.text()).toContain("Plans & billing")
  expect(wrapper.text()).not.toContain("Upgrade plan")
})

test("a late previous-Team response cannot advertise its plan on the next Team", async () => {
  const { central, team } = setup()
  await flushPromises()
  const old = Promise.withResolvers<TeamBilling>()
  central.billing.mockReturnValueOnce(old.promise)
  window.dispatchEvent(new Event("focus"))
  const next = Promise.withResolvers<TeamBilling>()
  central.billing.mockReturnValueOnce(next.promise)
  team.value = { ...team.value, id: "team-2", name: "Engineering" }
  await flushPromises()
  old.resolve(free)
  await flushPromises()
  expect(wrapper.text()).not.toContain("Upgrade plan")
  expect(wrapper.text()).not.toContain("Free")
  next.resolve({ ...free, plan: "pro" })
  await flushPromises()
  expect(wrapper.text()).toContain("Pro")
  expect(wrapper.text()).not.toContain("Upgrade plan")
})

test("billing lookup failure retains a working neutral entry", async () => {
  const { central, account } = setup()
  central.billing.mockRejectedValue(new Error("offline"))
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  await wrapper.get("button").trigger("click")
  expect(account.openSettings).toHaveBeenCalledWith("plans")
  expect(wrapper.text()).toContain("Plans & billing")
})

test.each(["success", "failure"] as const)("focus refresh preserves the current plan and CTA until %s", async outcome => {
  const { central } = setup()
  await flushPromises()
  const refreshed = Promise.withResolvers<TeamBilling>()
  central.billing.mockReturnValueOnce(refreshed.promise)
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect(wrapper.get("button").text()).toContain("Upgrade plan")
  expect(wrapper.get("[data-billing-entry] span:last-child").text()).toBe("Free")
  if (outcome === "success") refreshed.resolve({ ...free, plan: "pro" })
  else refreshed.reject(new Error("offline"))
  await flushPromises()
  expect(wrapper.get("button").text()).toContain(outcome === "success" ? "Plans & billing" : "Upgrade plan")
  expect(wrapper.get("[data-billing-entry] span:last-child").text()).toBe(outcome === "success" ? "Pro" : "Free")
})
