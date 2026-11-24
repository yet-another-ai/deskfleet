import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { computed, ref } from "vue"
import { afterEach, expect, test, vi } from "vitest"
import type { TeamBilling } from "@deskfleet/client/billing"
import { HttpError } from "@deskfleet/client/http-central"
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

test("free owner sees compact borderless upgrade CTA without a machine", async () => {
  const { account } = setup()
  await flushPromises()
  expect(wrapper.find("[data-billing-entry]").exists()).toBe(true)
  expect(wrapper.text()).toContain("Upgrade plan")
  expect(wrapper.text()).not.toContain("Design")
  expect(trackEvent).not.toHaveBeenCalled()
  await wrapper.get("button").trigger("click")
  expect(account.openSettings).toHaveBeenCalledWith("plans")
  expect(trackEvent).toHaveBeenCalledWith("billing_entry_clicked", { source: "sidebar", current_plan: "free", action: "upgrade" })
})

test.each([
  { plan: "go" as const }, { plan: "pro" as const }, { plan: "selfHosted" as const }, { canManageBilling: false },
  { paymentsAvailable: false }, { manualGrant: { plan: "free" as const, expiresAt: null } },
  { subscription: { plan: "go" as const, status: "past_due", paidThrough: null, cancelAtPeriodEnd: false } },
])("hides sidebar billing entry for %j", async override => {
  setup({ ...free, ...override })
  await flushPromises()
  expect(wrapper.find("[data-billing-entry]").exists()).toBe(false)
})

test("a late previous-Team response cannot advertise upgrade on the next Team", async () => {
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
  expect(wrapper.find("[data-billing-entry]").exists()).toBe(false)
  next.resolve({ ...free, plan: "pro" })
  await flushPromises()
  expect(wrapper.find("[data-billing-entry]").exists()).toBe(false)
})

test("billing lookup failure hides the sidebar CTA without reporting an unhandled global error", async () => {
  const reportError = vi.fn()
  vi.stubGlobal("reportError", reportError)
  const { central } = setup()
  central.billing.mockRejectedValue(new HttpError(401, "Unauthorized", undefined, "unauthorized"))
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect(reportError).not.toHaveBeenCalled()
  expect(wrapper.find("[data-billing-entry]").exists()).toBe(false)
})

test.each(["success", "failure"] as const)("focus refresh preserves upgrade CTA until %s resolves", async outcome => {
  const { central } = setup()
  await flushPromises()
  const refreshed = Promise.withResolvers<TeamBilling>()
  central.billing.mockReturnValueOnce(refreshed.promise)
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect(wrapper.get("button").text()).toContain("Upgrade plan")
  if (outcome === "success") refreshed.resolve({ ...free, plan: "pro" })
  else refreshed.reject(new Error("offline"))
  await flushPromises()
  expect(wrapper.find("[data-billing-entry]").exists()).toBe(outcome === "failure")
})
