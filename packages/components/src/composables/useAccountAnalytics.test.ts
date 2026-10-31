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

test("account refreshes, email changes, account changes, and sign-out synchronize identity", async () => {
  const fake = fakeCentral()
  const session = createAccountSession(fake.central)
  const scope = effectScope()
  scope.run(() => useAccountAnalytics(session))
  try {
    expect(identifyAnalytics).toHaveBeenLastCalledWith(undefined, undefined, undefined)
    await flushPromises()
    expect(identifyAnalytics).toHaveBeenLastCalledWith("user-1", { id: "team-1", role: "admin" }, "ada@example.test")
    const count = vi.mocked(identifyAnalytics).mock.calls.length
    await session.reload()
    expect(identifyAnalytics).toHaveBeenCalledTimes(count)
    expect(session.central.billing).not.toHaveBeenCalled()
    session.account.value = { ...session.account.value, user: { ...session.account.value.user!, email: "new@example.test" } }
    expect(identifyAnalytics).toHaveBeenLastCalledWith("user-1", { id: "team-1", role: "admin" }, "new@example.test")
    session.account.value = { ...session.account.value, user: { ...session.account.value.user!, email: null } }
    expect(identifyAnalytics).toHaveBeenLastCalledWith("user-1", { id: "team-1", role: "admin" }, undefined)
    session.account.value = { ...session.account.value, user: { id: "another-user", name: "Bob" } }
    expect(identifyAnalytics).toHaveBeenLastCalledWith("another-user", { id: "team-1", role: "admin" }, undefined)
    await session.signOut()
    expect(identifyAnalytics).toHaveBeenLastCalledWith(undefined, undefined, undefined)
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
    expect(identifyAnalytics).toHaveBeenLastCalledWith(session.account.value.user?.id, { id: "two", role: "member" }, "ada@example.test")
    first.resolve({ ...(await fake.central.billing("one")), plan: "pro" })
    await flushPromises()
    expect(setPlan).not.toHaveBeenCalledWith("one", "pro")
    expect(setPlan).toHaveBeenCalledWith("two", "selfHosted")
  } finally { scope.stop(); session.dispose() }
})
