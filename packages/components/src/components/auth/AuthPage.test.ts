import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { HttpError, type HttpCentralClient } from "@deskfleet/client/http-central"
import { i18n } from "../../i18n/index.ts"
import AuthPage from "./AuthPage.vue"

let view: VueWrapper | undefined
afterEach(() => { view?.unmount(); history.replaceState(null, "", "/"); vi.restoreAllMocks() })

test("desktop approval asks for recent authentication without losing its attempt", async () => {
  history.replaceState(null, "", "/auth/desktop?attempt=native-attempt")
  const assign = vi.spyOn(location, "assign").mockImplementation(() => {})
  let approvals = 0
  const request = vi.fn(async (_method: string, path: string, _body?: unknown) => {
    if (path === "/api/auth/config") return { registrationEnabled: true }
    if (path === "/api/auth/desktop/complete") {
      if (++approvals === 1) throw new HttpError(403, "Confirm your identity", undefined, "recent_authentication_required")
      return { returnTo: "http://127.0.0.1:19091/callback?code=approved" }
    }
    return {}
  })
  const api = { request, status: async () => ({ user: { id: "u1", email: "ada@example.test" } }) } as unknown as HttpCentralClient
  view = mount(AuthPage, { props: { api }, global: { plugins: [i18n] } })
  await flushPromises()
  expect(view.find('input[type="password"]').exists()).toBe(false)
  await view.get("form").trigger("submit"); await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe("Confirm your identity")
  await view.get('input[type="password"]').setValue("A fresh password proof")
  await view.get("form").trigger("submit"); await flushPromises()
  expect(request.mock.calls.slice(-2)).toEqual([
    ["POST", "/api/auth/reauthenticate", { password: "A fresh password proof" }],
    ["POST", "/api/auth/desktop/complete", { attempt: "native-attempt" }],
  ])
  expect(assign).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:19091/callback?code=approved")
})

test("closed registration presents the site policy without an email submission form", async () => {
  history.replaceState(null, "", "/auth/register")
  const api = { request: async () => ({ registrationEnabled: false }), status: async () => ({}) } as unknown as HttpCentralClient
  view = mount(AuthPage, { props: { api }, global: { plugins: [i18n] } })
  await flushPromises()
  expect(view.find("form").exists()).toBe(false)
  expect(view.get('[role="status"]').text()).toBe(i18n.global.t("auth.registrationClosed"))
})
