import { effectScope } from "vue"
import { flushPromises } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { fakeCentral } from "../test/central.ts"
import { setErrorReportingUser } from "../services/error-reporting.ts"
import { createAccountSession } from "./useAccountSession.ts"
import { useErrorReportingUser } from "./useErrorReportingUser.ts"

vi.mock("../services/error-reporting.ts", () => ({ setErrorReportingUser: vi.fn() }))
afterEach(() => vi.clearAllMocks())

test("account loading, email changes, account changes, sign-out and teardown synchronize reporting identity", async () => {
  const fake = fakeCentral()
  const session = createAccountSession(fake.central)
  const scope = effectScope()
  scope.run(() => useErrorReportingUser(() => session.account.value.user))
  try {
    expect(setErrorReportingUser).toHaveBeenLastCalledWith(undefined)
    await flushPromises()
    expect(setErrorReportingUser).toHaveBeenLastCalledWith({ id: "user-1", email: "ada@example.test" })
    const count = vi.mocked(setErrorReportingUser).mock.calls.length
    await session.reload()
    expect(setErrorReportingUser).toHaveBeenCalledTimes(count)
    session.account.value.user!.email = "new@example.test"
    expect(setErrorReportingUser).toHaveBeenLastCalledWith({ id: "user-1", email: "new@example.test" })
    session.account.value.user!.email = null
    expect(setErrorReportingUser).toHaveBeenLastCalledWith({ id: "user-1", email: null })
    session.account.value.user = { id: "user-2", name: "Bob" }
    expect(setErrorReportingUser).toHaveBeenLastCalledWith({ id: "user-2", email: undefined })
    await session.signOut()
    expect(setErrorReportingUser).toHaveBeenLastCalledWith(undefined)
    session.account.value.user = { id: "user-3", name: "Carol", email: "carol@example.test" }
    expect(setErrorReportingUser).toHaveBeenLastCalledWith({ id: "user-3", email: "carol@example.test" })
  } finally { scope.stop(); session.dispose() }
  expect(setErrorReportingUser).toHaveBeenLastCalledWith()
  const count = vi.mocked(setErrorReportingUser).mock.calls.length
  session.account.value.user = { id: "after-dispose", name: "Unobserved" }
  expect(setErrorReportingUser).toHaveBeenCalledTimes(count)
})

test("successful sign-out clears identity even if the subsequent account refresh fails", async () => {
  const fake = fakeCentral()
  const session = createAccountSession(fake.central)
  const scope = effectScope()
  scope.run(() => useErrorReportingUser(() => session.account.value.user))
  try {
    await flushPromises()
    fake.central.logout.mockRejectedValueOnce(new Error("Logout unavailable"))
    await expect(session.signOut()).rejects.toThrow("Logout unavailable")
    expect(setErrorReportingUser).toHaveBeenLastCalledWith({ id: "user-1", email: "ada@example.test" })
    fake.central.status.mockRejectedValue(new Error("Status unavailable"))
    await expect(session.signOut()).rejects.toThrow("Status unavailable")
    expect(session.account.value.user).toBeUndefined()
    expect(setErrorReportingUser).toHaveBeenLastCalledWith(undefined)
  } finally { scope.stop(); session.dispose() }
})
