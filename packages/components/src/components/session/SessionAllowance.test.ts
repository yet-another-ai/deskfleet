import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { AgentSnapshot } from "../../../../../apps/daemon/src/agent-protocol.ts"
import { accountSessionKey, createAccountSession, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import { billingFixture, fakeCentral } from "../../test/central.ts"
import SessionAllowance from "./SessionAllowance.vue"
import { trackEvent } from "../../services/analytics.ts"

vi.mock("../../services/analytics.ts", () => ({ trackEvent: vi.fn() }))

let view: VueWrapper | undefined
let session: AccountSession | undefined
beforeEach(() => vi.mocked(trackEvent).mockClear())
afterEach(async () => { view?.unmount(); view = undefined; session?.dispose(); session = undefined; await router.replace("/") })

async function mountWith(maxTurnsPerSession: number | null, inheritedTurnCount: number, consumed: number, turnLimitReason?: string) {
  const fake = fakeCentral()
  fake.central.billing.mockResolvedValue({ ...billingFixture(), plan: "free", limits: { maxActiveSessions: 3, maxTurnsPerSession, maxMembers: 3, turnBytes: 0 } })
  session = createAccountSession(fake.central)
  await flushPromises()
  const snapshot = { session: { id: "30", inheritedTurnCount, turnLimitReason }, turns: Array.from({ length: consumed }, () => ({ consumed: true })) } as unknown as AgentSnapshot
  view = mount(SessionAllowance, { props: { snapshot }, global: { plugins: [i18n], provide: { [accountSessionKey as symbol]: session } } })
  await flushPromises()
  return { fake, snapshot }
}

test("a Free Session shows its count, including turns inherited from a fork", async () => {
  await mountWith(30, 4, 8)
  expect(view!.get("[data-session-turns]").text()).toBe("12 of 30 turns used in this Session · 4 carried over from the source Session")
  expect(view!.find('[role="status"]').exists()).toBe(false)
  expect(trackEvent).not.toHaveBeenCalled()
})

test("the last few turns warn and link to the Team's plans", async () => {
  await mountWith(30, 24, 5)
  expect(view!.get('[role="status"]').text()).toContain("1 turn left of 30 in this Session")
  expect(view!.get("button").text()).toBe("View plans")
  expect(trackEvent).toHaveBeenCalledExactlyOnceWith("session_turn_allowance_viewed", { state: "near_limit", used_turns: 29, turn_limit: 30 })
  await view!.get("button").trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe("/team/settings/plans"))
  expect(trackEvent).toHaveBeenLastCalledWith("session_turn_plans_clicked", { source: "near_limit" })
})

test("a paused Session shows the daemon's reason and that queued input is kept", async () => {
  await mountWith(30, 0, 30, "This Session has used its 30 Free turns.")
  expect(view!.get('[role="status"]').text()).toContain("This Session has used its 30 Free turns.")
  expect(view!.text()).toContain("Queued input is kept.")
  expect(vi.mocked(trackEvent).mock.calls).toEqual([
    ["session_turn_allowance_viewed", { state: "blocked", used_turns: 30 }],
    ["session_turn_allowance_viewed", { state: "reached", used_turns: 30, turn_limit: 30 }],
  ])
  await view!.get("button").trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe("/team/settings/plans"))
  expect(trackEvent).toHaveBeenLastCalledWith("session_turn_plans_clicked", { source: "reached" })
})

test.each([30, null])("an authority failure with turn limit %s records blocked rather than exhausted", async limit => {
  await mountWith(limit, 0, 1, "The entitlement service is unavailable")
  expect(trackEvent).toHaveBeenCalledExactlyOnceWith("session_turn_allowance_viewed", { state: "blocked", used_turns: 1 })
  await view!.get("button").trigger("click")
  expect(trackEvent).toHaveBeenLastCalledWith("session_turn_plans_clicked", { source: "blocked" })
})

test("turn warnings count each boundary once per Session across snapshots and focus refreshes", async () => {
  const { snapshot } = await mountWith(30, 20, 5)
  const remaining = { ...snapshot, session: { ...snapshot.session, inheritedTurnCount: 24 } }
  await view!.setProps({ snapshot: remaining })
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect(trackEvent).toHaveBeenCalledTimes(1)
  const reached = { ...remaining, session: { ...remaining.session, inheritedTurnCount: 25 } }
  await view!.setProps({ snapshot: reached })
  expect(trackEvent).toHaveBeenLastCalledWith("session_turn_allowance_viewed", { state: "reached", used_turns: 30, turn_limit: 30 })
  await view!.setProps({ snapshot: remaining })
  await view!.setProps({ snapshot: reached })
  expect(trackEvent).toHaveBeenCalledTimes(2)
  await view!.setProps({ snapshot: { ...reached, session: { ...reached.session, id: "31" } } })
  expect(trackEvent).toHaveBeenCalledTimes(3)
})

test("reopening the same account's Session does not repeat its allowance impression", async () => {
  const { snapshot } = await mountWith(30, 20, 5)
  view!.unmount()
  view = mount(SessionAllowance, { props: { snapshot }, global: { plugins: [i18n], provide: { [accountSessionKey as symbol]: session } } })
  await flushPromises()
  expect(trackEvent).toHaveBeenCalledExactlyOnceWith("session_turn_allowance_viewed", { state: "near_limit", used_turns: 25, turn_limit: 30 })
})

test("unlimited plans show nothing", async () => {
  await mountWith(null, 0, 3)
  expect(view!.text()).toBe("")
  expect(trackEvent).not.toHaveBeenCalled()
})
