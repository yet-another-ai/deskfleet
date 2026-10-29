import { effectScope } from "vue"
import { flushPromises } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { fakeCentral } from "../test/central.ts"
import { analyticsEnabled, identifyAnalytics } from "../services/analytics.ts"
import { createAccountSession } from "./useAccountSession.ts"
import { useAccountAnalytics } from "./useAccountAnalytics.ts"

const setPlan = vi.hoisted(() => vi.fn())
vi.mock("../services/analytics.ts", () => ({ identifyAnalytics: vi.fn(), analyticsEnabled: vi.fn(() => false), beginAnalyticsPlanRefresh: (team: string) => (plan: string) => setPlan(team, plan) }))
afterEach(() => { vi.clearAllMocks(); vi.mocked(analyticsEnabled).mockReturnValue(false) })

test("account refreshes, account changes, and sign-out synchronize only the user ID", async () => {
  const fake = fakeCentral()
  const session = createAccountSession(fake.central)
  const scope = effectScope()
  scope.run(() => useAccountAnalytics(session))
  try {
    expect(identifyAnalytics).toHaveBeenLastCalledWith(undefined, undefined)
    await flushPromises()
    expect(vi.mocked(identifyAnalytics).mock.calls.at(-1)?.[0]).toBe(session.account.value.user?.id)
    const count = vi.mocked(identifyAnalytics).mock.calls.length
    await session.reload()
    expect(identifyAnalytics).toHaveBeenCalledTimes(count)
    expect(session.central.billing).not.toHaveBeenCalled()
    session.account.value = { ...session.account.value, user: { ...session.account.value.user!, id: "another-user" } }
    expect(vi.mocked(identifyAnalytics).mock.calls.at(-1)?.[0]).toBe("another-user")
    await session.signOut()
    expect(vi.mocked(identifyAnalytics).mock.calls.at(-1)?.[0]).toBeUndefined()
  } finally { scope.stop(); session.dispose() }
})

test("Team selection refreshes plan context and drops an old Team's late response", async () => {
  vi.mocked(analyticsEnabled).mockReturnValue(true)
  const fake = fakeCentral({ teams: [{ id: "one", name: "One", role: "admin" }, { id: "two", name: "Two", role: "member" }] })
  const session = createAccountSession(fake.central)
  await flushPromises()
  const first = Promise.withResolvers<Awaited<ReturnType<typeof fake.central.billing>>>()
  fake.central.billing.mockReturnValueOnce(first.promise)
  const scope = effectScope()
  scope.run(() => useAccountAnalytics(session))
  try {
    await session.selectTeam("two")
    await flushPromises()
    expect(identifyAnalytics).toHaveBeenLastCalledWith(session.account.value.user?.id, { id: "two", role: "member" })
    first.resolve({ ...(await fake.central.billing("one")), plan: "pro" })
    await flushPromises()
    expect(setPlan).not.toHaveBeenCalledWith("one", "pro")
    expect(setPlan).toHaveBeenCalledWith("two", "selfHosted")
  } finally { scope.stop(); session.dispose() }
})
