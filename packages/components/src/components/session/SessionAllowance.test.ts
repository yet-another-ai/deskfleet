import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import type { AgentSnapshot } from "../../../../../apps/daemon/src/agent-protocol.ts"
import { accountSessionKey, createAccountSession, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import { billingFixture, fakeCentral } from "../../test/central.ts"
import SessionAllowance from "./SessionAllowance.vue"

let view: VueWrapper | undefined
let session: AccountSession | undefined
afterEach(async () => { view?.unmount(); view = undefined; session?.dispose(); session = undefined; await router.replace("/") })

async function mountWith(maxTurnsPerSession: number | null, inheritedTurnCount: number, consumed: number, turnLimitReason?: string) {
  const fake = fakeCentral()
  fake.central.billing.mockResolvedValue({ ...billingFixture(), plan: "free", limits: { maxActiveSessions: 3, maxTurnsPerSession, maxMembers: 3, turnBytes: 0 } })
  session = createAccountSession(fake.central)
  await flushPromises()
  const snapshot = { session: { inheritedTurnCount, turnLimitReason }, turns: Array.from({ length: consumed }, () => ({ consumed: true })) } as unknown as AgentSnapshot
  view = mount(SessionAllowance, { props: { snapshot }, global: { plugins: [i18n], provide: { [accountSessionKey as symbol]: session } } })
  await flushPromises()
}

test("a Free Session shows its count, including turns inherited from a fork", async () => {
  await mountWith(30, 4, 8)
  expect(view!.get("[data-session-turns]").text()).toBe("12 of 30 turns used in this Session · 4 carried over from the source Session")
  expect(view!.find('[role="status"]').exists()).toBe(false)
})

test("the last few turns warn and link to the Team's plans", async () => {
  await mountWith(30, 24, 5)
  expect(view!.get('[role="status"]').text()).toContain("1 turn left of 30 in this Session")
  expect(view!.get("button").text()).toBe("View plans")
  await view!.get("button").trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe("/team/settings/plans"))
})

test("a paused Session shows the daemon's reason and that queued input is kept", async () => {
  await mountWith(30, 0, 30, "This Session has used its 30 Free turns.")
  expect(view!.get('[role="status"]').text()).toContain("This Session has used its 30 Free turns.")
  expect(view!.text()).toContain("Queued input is kept.")
  await view!.get("button").trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe("/team/settings/plans"))
})

test("unlimited plans show nothing", async () => {
  await mountWith(null, 0, 3)
  expect(view!.text()).toBe("")
})
