import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { HttpError, type HttpCentralClient } from "@deskfleet/client/http-central"
import { i18n } from "../../i18n/index.ts"
import AuthPage from "./AuthPage.vue"

let view: VueWrapper | undefined
afterEach(() => { view?.unmount(); history.replaceState(null, "", "/"); vi.restoreAllMocks(); vi.useRealTimers() })
const recentRequired = () => new HttpError(403, "Confirm your password or Passkey to continue.", undefined, "recent_authentication_required")
const dialog = () => new DOMWrapper(document.body).find('[role="dialog"]')
const button = (root: { findAll(selector: string): DOMWrapper<Element>[] }, label: string) => root.findAll("button").find(value => value.text() === label)!

function mountAt(path: string, request: (method: string, path: string, body?: unknown) => Promise<unknown>, user?: object) {
  history.replaceState(null, "", path)
  const api = { request: vi.fn(request), status: async () => ({ user }), logout: vi.fn(async () => {}) } as unknown as HttpCentralClient
  view = mount(AuthPage, { props: { api }, global: { plugins: [i18n] }, attachTo: document.body })
  return api.request as ReturnType<typeof vi.fn>
}

test("desktop approval confirms recent authentication in a dialog and keeps its attempt", async () => {
  const assign = vi.spyOn(location, "assign").mockImplementation(() => {})
  let approvals = 0
  const request = mountAt("/auth/desktop?attempt=native-attempt", async (_method, path) => {
    if (path === "/api/auth/config") return { registrationEnabled: true }
    if (path === "/api/auth/desktop/complete") {
      if (++approvals === 1) throw recentRequired()
      return { returnTo: "http://127.0.0.1:19091/callback?code=approved" }
    }
    return {}
  }, { id: "u1", name: "Ada", email: "ada@example.test" })
  await flushPromises()
  expect(view!.find('input[type="email"]').exists()).toBe(false)
  expect(view!.text()).toContain("ada@example.test")
  await view!.get("form").trigger("submit"); await flushPromises()
  expect(dialog().text()).toContain(i18n.global.t("auth.reauthTitle"))
  expect(assign).not.toHaveBeenCalled()
  await dialog().get('input[type="password"]').setValue("A fresh password proof")
  await dialog().get("form").trigger("submit"); await flushPromises()
  expect(request.mock.calls.slice(-2)).toEqual([
    ["POST", "/api/auth/reauthenticate", { password: "A fresh password proof" }],
    ["POST", "/api/auth/desktop/complete", { attempt: "native-attempt" }],
  ])
  expect(assign).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:19091/callback?code=approved")
  expect(dialog().exists()).toBe(false)
})

test("closed registration presents the site policy without an email submission form", async () => {
  mountAt("/auth/register", async () => ({ registrationEnabled: false }))
  await flushPromises()
  expect(view!.find("form").exists()).toBe(false)
  expect(view!.get('[role="status"]').text()).toBe(i18n.global.t("auth.registrationClosed"))
})

test("registration confirms the mailed link and resends to the same address after a pause", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  const request = mountAt("/auth/register", async () => ({ registrationEnabled: true }))
  await flushPromises()
  await view!.get('input[type="email"]').setValue("grace@example.test")
  await view!.get("form").trigger("submit"); await flushPromises()
  expect(view!.get("h1").text()).toBe(i18n.global.t("auth.checkInbox"))
  expect(view!.text()).toContain("grace@example.test")
  const resend = button(view!, i18n.global.t("auth.resend"))
  expect(resend.attributes("disabled")).toBeDefined()
  vi.advanceTimersByTime(30_000); await flushPromises()
  await resend.trigger("click"); await flushPromises()
  expect(request.mock.calls.filter(([, path]) => path === "/api/auth/register")).toEqual([
    ["POST", "/api/auth/register", { email: "grace@example.test" }],
    ["POST", "/api/auth/register", { email: "grace@example.test" }],
  ])
  expect(view!.get('[role="status"]').text()).toBe(i18n.global.t("auth.sentAgain"))
})

test("a mailed link without its token offers a new link instead of a form", async () => {
  mountAt("/auth/recovery/complete", async () => ({ registrationEnabled: true }))
  await flushPromises()
  expect(view!.find("form").exists()).toBe(false)
  expect(view!.get("h1").text()).toBe(i18n.global.t("auth.linkInvalid"))
  expect(view!.get('a[href="/auth/recovery"]').text()).toBe(i18n.global.t("auth.requestNewLink"))
})

test("signing out everywhere is confirmed, then retried after recent authentication", async () => {
  const assign = vi.spyOn(location, "assign").mockImplementation(() => {})
  let revocations = 0
  const request = mountAt("/auth/account", async (_method, path) => {
    if (path === "/api/auth/config") return { registrationEnabled: true }
    if (path === "/api/auth/passkeys") return []
    if (path === "/api/auth/sessions") return [
      { id: "s1", deviceId: "s1", createdAt: "2026-10-20T10:00:00Z", expiresAt: "2026-11-19T10:00:00Z", current: true },
      { id: "s2", deviceId: "s2", createdAt: "2026-10-21T10:00:00Z", expiresAt: "2026-11-20T10:00:00Z", current: false },
    ]
    if (path === "/api/auth/sessions/revoke-all" && ++revocations === 1) throw recentRequired()
    return {}
  }, { id: "u1", name: "Ada", email: "ada@example.test" })
  await flushPromises()
  expect(view!.findAll("[data-login-session]")).toHaveLength(2)
  await button(view!, i18n.global.t("auth.revokeAll")).trigger("click"); await flushPromises()
  await button(dialog(), i18n.global.t("auth.revokeAll")).trigger("click"); await flushPromises()
  const prompt = new DOMWrapper(document.body).findAll('[role="dialog"]').at(-1)!
  expect(prompt.text()).toContain(i18n.global.t("auth.reauthTitle"))
  await prompt.get('input[type="password"]').setValue("correct horse battery staple")
  await prompt.get("form").trigger("submit"); await flushPromises()
  expect(request.mock.calls.filter(([, path]) => path.startsWith("/api/auth/sessions/") || path === "/api/auth/reauthenticate").map(([, path]) => path)).toEqual([
    "/api/auth/sessions/revoke-all", "/api/auth/reauthenticate", "/api/auth/sessions/revoke-all",
  ])
  expect(assign).toHaveBeenCalledExactlyOnceWith("/auth/login")
})
