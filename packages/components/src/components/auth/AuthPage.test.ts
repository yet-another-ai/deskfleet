import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { HttpError, type HttpCentralClient } from "@deskfleet/client/http-central"
import { i18n } from "../../i18n/index.ts"
import AuthPage from "./AuthPage.vue"

let view: VueWrapper | undefined
afterEach(() => { view?.unmount(); sessionStorage.clear(); history.replaceState(null, "", "/"); vi.restoreAllMocks(); vi.useRealTimers() })
const recentRequired = () => new HttpError(403, "Confirm your password or Passkey to continue.", undefined, "recent_authentication_required")
const dialog = () => new DOMWrapper(document.body).find('[role="dialog"]')
const button = (root: { findAll(selector: string): DOMWrapper<Element>[] }, label: string) => root.findAll("button").find(value => value.text() === label)!
const oauthProviders = [
  { provider: "github", label: "auth.signInWithGithub", authorizationUrl: "https://github.com/login/oauth/authorize" },
  { provider: "google", label: "auth.signInWithGoogle", authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth" },
]

function mountAt(path: string, request: (method: string, path: string, body?: unknown) => Promise<unknown>, user?: object) {
  history.replaceState(null, "", path)
  const api = { request: vi.fn(request), status: async () => ({ user }), logout: vi.fn(async () => {}) } as unknown as HttpCentralClient
  view = mount(AuthPage, { props: { api }, global: { plugins: [i18n] }, attachTo: document.body })
  return api.request as ReturnType<typeof vi.fn>
}

test.each(["/auth/desktop?attempt=native-attempt", "/auth/github-app?user=u1"])("focus refresh preserves the sign-in form on %s", async path => {
  let finishRefresh: ((value: unknown) => void) | undefined
  let configCalls = 0
  mountAt(path, async () => {
    if (++configCalls === 1) return { registrationEnabled: true }
    return new Promise(resolve => { finishRefresh = resolve })
  })
  await flushPromises()
  await view!.get('input[type="email"]').setValue("ada@example.test")
  await view!.get('input[type="password"]').setValue("password in progress")
  window.dispatchEvent(new Event("focus"))
  await view!.vm.$nextTick()
  expect((view!.get('input[type="email"]').element as HTMLInputElement).value).toBe("ada@example.test")
  expect((view!.get('input[type="password"]').element as HTMLInputElement).value).toBe("password in progress")
  finishRefresh!({ registrationEnabled: true })
  await flushPromises()
  expect((view!.get('input[type="email"]').element as HTMLInputElement).value).toBe("ada@example.test")
  expect((view!.get('input[type="password"]').element as HTMLInputElement).value).toBe("password in progress")
})

test("a failed focus refresh keeps the sign-in form", async () => {
  let calls = 0
  mountAt("/auth/desktop", async () => {
    if (++calls > 1) throw new Error("network failure")
    return { registrationEnabled: true }
  })
  await flushPromises()
  await view!.get('input[type="email"]').setValue("ada@example.test")
  await view!.get('input[type="password"]').setValue("password in progress")
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect((view!.get('input[type="email"]').element as HTMLInputElement).value).toBe("ada@example.test")
  expect((view!.get('input[type="password"]').element as HTMLInputElement).value).toBe("password in progress")
})

test("an initial loading failure offers a retry", async () => {
  mountAt("/auth/desktop", async () => { throw new Error("network failure") })
  await flushPromises()
  expect(view!.text()).toContain(i18n.global.t("auth.unavailable"))
  expect(button(view!, i18n.global.t("auth.retry"))).toBeDefined()
})

test("a refresh failure after signing in offers a retry", async () => {
  let configCalls = 0
  mountAt("/auth/desktop?attempt=native-attempt", async (_method, path) => {
    if (path === "/api/auth/config" && ++configCalls > 1) throw new Error("network failure")
    return { registrationEnabled: true }
  })
  await flushPromises()
  await view!.get('input[type="email"]').setValue("ada@example.test")
  await view!.get('input[type="password"]').setValue("password")
  await view!.get("form").trigger("submit"); await flushPromises()
  expect(view!.text()).toContain(i18n.global.t("auth.unavailable"))
  expect(button(view!, i18n.global.t("auth.retry"))).toBeDefined()
})

test("signing out hides the previous account while refreshing", async () => {
  let configCalls = 0
  let finishRefresh: ((value: unknown) => void) | undefined
  mountAt("/auth/desktop?attempt=native-attempt", async () => {
    if (++configCalls === 1) return { registrationEnabled: true }
    return new Promise(resolve => { finishRefresh = resolve })
  }, { id: "u1", name: "Ada", email: "ada@example.test" })
  await flushPromises()
  await button(view!, i18n.global.t("auth.differentAccount")).trigger("click")
  await view!.vm.$nextTick()
  expect(view!.text()).toContain(i18n.global.t("auth.loading"))
  expect(view!.text()).not.toContain("ada@example.test")
  finishRefresh!({ registrationEnabled: true })
  await flushPromises()
})

test("focus refresh detects a sign-in in another tab", async () => {
  history.replaceState(null, "", "/auth/desktop?attempt=native-attempt")
  let user: object | undefined
  const api = { request: vi.fn(async () => ({ registrationEnabled: true })), status: async () => ({ user }), logout: vi.fn(async () => {}) } as unknown as HttpCentralClient
  view = mount(AuthPage, { props: { api }, global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  expect(view!.find('input[type="email"]').exists()).toBe(true)
  user = { id: "u1", name: "Ada", email: "ada@example.test" }
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect(view!.find('input[type="email"]').exists()).toBe(false)
  expect(view!.text()).toContain("ada@example.test")
})

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

test.each(oauthProviders.flatMap(value => [true, false].map(registrationEnabled => ({ ...value, registrationEnabled }))))("$provider sign-in requires terms even when registrationEnabled=$registrationEnabled", async ({ provider, label, authorizationUrl, registrationEnabled }) => {
  const assign = vi.spyOn(location, "assign").mockImplementation(() => {})
  const request = mountAt("/auth/desktop?attempt=native-attempt", async (_method, path) => {
    if (path === "/api/auth/config") return { registrationEnabled, [`${provider}Enabled`]: true, termsOfServiceUrl: "https://example.test/terms", privacyTermsUrl: "" }
    if (path === `/api/auth/${provider}/start`) return { authorizationUrl }
    return {}
  })
  await flushPromises()
  const signIn = button(view!, i18n.global.t(label))
  expect(signIn.attributes("disabled")).toBeUndefined()
  await signIn.trigger("click"); await flushPromises()
  expect(request).not.toHaveBeenCalledWith("POST", `/api/auth/${provider}/start`, expect.anything())
  const checkbox = view!.get('[role="checkbox"]')
  expect(checkbox.attributes("aria-invalid")).toBe("true")
  expect(view!.get('[role="alert"]').text()).toBe(i18n.global.t(`auth.${provider}TermsRequired`))
  expect(view!.find(".terms-shake").exists()).toBe(true)
  await view!.get(".terms-shake").trigger("animationend")
  await signIn.trigger("click"); await flushPromises()
  expect(view!.find(".terms-shake").exists()).toBe(true)
  await checkbox.trigger("click")
  expect(checkbox.attributes("aria-invalid")).toBeUndefined()
  expect(view!.find('[role="alert"]').exists()).toBe(false)
  await signIn.trigger("click"); await flushPromises()
  expect(request).toHaveBeenCalledWith("POST", `/api/auth/${provider}/start`, { returnTo: "/auth/desktop?attempt=native-attempt", acceptedTerms: true })
  expect(assign).toHaveBeenCalledExactlyOnceWith(authorizationUrl)
})

test.each(oauthProviders.flatMap(value => [
  { code: "terms_required", message: "TermsRequired" },
  { code: "registration_disabled", message: "RegistrationDisabled" },
  { code: "email_conflict", message: "EmailConflict" },
  { code: "failed", message: "Failed" },
  { code: "unknown", message: "Failed" },
].map(error => ({ ...value, ...error }))))("$provider callback error $code is displayed and removed from browser history", async ({ provider, message, code }) => {
  mountAt(`/auth/login?${provider}Error=${code}`, async () => ({ registrationEnabled: true, [`${provider}Enabled`]: true }))
  await flushPromises()
  expect(view!.get('[role="alert"]').text()).toBe(i18n.global.t(`auth.${provider}${message}`))
  expect(location.search).toBe("")
})

test.each(oauthProviders)("$provider sign-in restores an email verification token without sending it in the return path", async ({ provider, label, authorizationUrl }) => {
  vi.spyOn(location, "assign").mockImplementation(() => {})
  const request = mountAt("/auth/email/verify#token=secret", async (_method, path) => {
    if (path === "/api/auth/config") return { registrationEnabled: true, [`${provider}Enabled`]: true }
    if (path === `/api/auth/${provider}/start`) return { authorizationUrl }
    return {}
  })
  await flushPromises()
  expect(location.hash).toBe("")
  await button(view!, i18n.global.t(label)).trigger("click"); await flushPromises()
  expect(request).toHaveBeenCalledWith("POST", `/api/auth/${provider}/start`, { returnTo: "/auth/email/verify", acceptedTerms: false })
  view!.unmount()
  const next = mountAt("/auth/email/verify", async () => ({ registrationEnabled: true, [`${provider}Enabled`]: true }), { id: "u1", name: "Ada", email: "ada@example.test" })
  await flushPromises()
  await view!.get("form").trigger("submit"); await flushPromises()
  expect(next).toHaveBeenCalledWith("POST", "/api/auth/email/verify", { token: "secret" })
  expect(sessionStorage.getItem("deskfleet-email-verify-token")).toBeNull()
})

test.each([true, false])("Google sign-in is shown only when configured: %s", async googleEnabled => {
  mountAt("/auth/login", async () => ({ registrationEnabled: true, githubEnabled: true, googleEnabled }))
  await flushPromises()
  expect(!!button(view!, i18n.global.t("auth.signInWithGoogle"))).toBe(googleEnabled)
  expect(button(view!, i18n.global.t("auth.signInWithGithub"))).toBeDefined()
})

test("Google sign-in shares consent with GitHub and preserves the continuation after a callback error", async () => {
  const assign = vi.spyOn(location, "assign").mockImplementation(() => {})
  const request = mountAt("/auth/desktop?attempt=native-attempt&googleError=failed", async (_method, path) => {
    if (path === "/api/auth/config") return { registrationEnabled: true, githubEnabled: true, googleEnabled: true, termsOfServiceUrl: "https://example.test/terms" }
    if (path === "/api/auth/google/start") return { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth" }
    return {}
  })
  await flushPromises()
  expect(view!.findAll('[role="checkbox"]')).toHaveLength(1)
  expect(location.search).toBe("?attempt=native-attempt")
  await view!.get('[role="checkbox"]').trigger("click")
  await button(view!, i18n.global.t("auth.signInWithGoogle")).trigger("click"); await flushPromises()
  expect(request).toHaveBeenCalledWith("POST", "/api/auth/google/start", { returnTo: "/auth/desktop?attempt=native-attempt", acceptedTerms: true })
  expect(assign).toHaveBeenCalledExactlyOnceWith("https://accounts.google.com/o/oauth2/v2/auth")
  expect(button(view!, i18n.global.t("auth.signInWithGithub")).attributes("disabled")).toBeDefined()
})

test("closed registration presents the site policy without an email submission form", async () => {
  mountAt("/auth/register", async () => ({ registrationEnabled: false }))
  await flushPromises()
  expect(view!.find("form").exists()).toBe(false)
  expect(view!.get('[role="status"]').text()).toBe(i18n.global.t("auth.registrationClosed"))
})

test("registration confirms the mailed link and resends to the same address after a pause", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  const request = mountAt("/auth/register", async () => ({ registrationEnabled: true, termsOfServiceUrl: "https://example.test/terms", privacyTermsUrl: "https://example.test/privacy" }))
  await flushPromises()
  await view!.get('input[type="email"]').setValue("grace@example.test")
  await view!.get('[role="checkbox"]').trigger("click")
  await view!.get("form").trigger("submit"); await flushPromises()
  expect(view!.get("h1").text()).toBe(i18n.global.t("auth.checkInbox"))
  expect(view!.text()).toContain("grace@example.test")
  const resend = button(view!, i18n.global.t("auth.resend"))
  expect(resend.attributes("disabled")).toBeDefined()
  vi.advanceTimersByTime(30_000); await flushPromises()
  await resend.trigger("click"); await flushPromises()
  expect(request.mock.calls.filter(([, path]) => path === "/api/auth/register")).toEqual([
    ["POST", "/api/auth/register", { email: "grace@example.test", acceptedTerms: true }],
    ["POST", "/api/auth/register", { email: "grace@example.test", acceptedTerms: true }],
  ])
  expect(view!.get('[role="status"]').text()).toBe(i18n.global.t("auth.sentAgain"))
})

test.each([
  { termsOfServiceUrl: "https://example.test/terms", privacyTermsUrl: "https://example.test/privacy" },
  { termsOfServiceUrl: "https://example.test/terms", privacyTermsUrl: "" },
  { termsOfServiceUrl: "", privacyTermsUrl: "https://example.test/privacy" },
])("registration requires explicit consent to configured terms: %j", async config => {
  const request = mountAt("/auth/register", async () => ({ registrationEnabled: true, ...config }))
  await flushPromises()
  await view!.get('input[type="email"]').setValue("grace@example.test")
  const checkbox = view!.get('[role="checkbox"]')
  const submit = view!.get('button[type="submit"]')
  const terms = [config.termsOfServiceUrl && "Terms of Service", config.privacyTermsUrl && "Privacy Terms"].filter(Boolean)
  expect(view!.get(`#${checkbox.attributes("aria-labelledby")}`).text().replace(/\s+/g, " ")).toBe(`I agree to the ${terms.join(" and ")}`)
  expect(checkbox.attributes("aria-checked")).toBe("false")
  expect(submit.attributes("disabled")).toBeDefined()
  // Exercise the submit handler as well as the disabled button.
  await view!.get("form").trigger("submit"); await flushPromises()
  expect(request.mock.calls.some(([, path]) => path === "/api/auth/register")).toBe(false)
  const links = view!.findAll('a[target="_blank"]')
  expect(links.map(link => link.attributes("href"))).toEqual(Object.values(config).filter(Boolean))
  for (const link of links) {
    expect(link.attributes("rel")).toBe("noopener noreferrer")
    await link.trigger("click")
    expect(checkbox.attributes("aria-checked")).toBe("false")
  }
  await checkbox.trigger("click")
  expect(submit.attributes("disabled")).toBeUndefined()
  await checkbox.trigger("click")
  expect(submit.attributes("disabled")).toBeDefined()
  await checkbox.trigger("click")
  await view!.get("form").trigger("submit"); await flushPromises()
  expect(request).toHaveBeenLastCalledWith("POST", "/api/auth/register", { email: "grace@example.test", acceptedTerms: true })
})

test("registration with no configured terms does not require a checkbox", async () => {
  const request = mountAt("/auth/register", async () => ({ registrationEnabled: true, termsOfServiceUrl: "", privacyTermsUrl: "" }))
  await flushPromises()
  expect(view!.find('[role="checkbox"]').exists()).toBe(false)
  expect(view!.get('button[type="submit"]').attributes("disabled")).toBeUndefined()
  await view!.get('input[type="email"]').setValue("grace@example.test")
  await view!.get("form").trigger("submit"); await flushPromises()
  expect(request).toHaveBeenLastCalledWith("POST", "/api/auth/register", { email: "grace@example.test", acceptedTerms: false })
})

test("recovery does not request consent even when registration terms are configured", async () => {
  const request = mountAt("/auth/recovery", async () => ({ registrationEnabled: true, termsOfServiceUrl: "https://example.test/terms", privacyTermsUrl: "https://example.test/privacy" }))
  await flushPromises()
  expect(view!.find('[role="checkbox"]').exists()).toBe(false)
  expect(view!.find('a[target="_blank"]').exists()).toBe(false)
  await view!.get('input[type="email"]').setValue("grace@example.test")
  await view!.get("form").trigger("submit"); await flushPromises()
  expect(request).toHaveBeenLastCalledWith("POST", "/api/auth/recovery", { email: "grace@example.test" })
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

test("GitHub App authorization confirms the expected DeskFleet account before redirecting", async () => {
  const assign = vi.spyOn(location, "assign").mockImplementation(() => {})
  const request = mountAt("/auth/github-app?user=u1", async (_method, path) => {
    if (path === "/api/auth/config") return { registrationEnabled: true }
    if (path === "/api/integrations/github") return { configured: true, authorized: false }
    if (path === "/api/integrations/github/authorization/start") return { authorizationUrl: "https://github.com/login/oauth/authorize?client_id=app" }
    return {}
  }, { id: "u1", name: "Ada", email: "ada@example.test" })
  await flushPromises()
  expect(view!.text()).toContain("ada@example.test")
  expect(assign).not.toHaveBeenCalled()
  await button(view!, "Authorize").trigger("click"); await flushPromises()
  expect(request).toHaveBeenCalledWith("POST", "/api/integrations/github/authorization/start", { expectedUserId: "u1" })
  expect(assign).toHaveBeenCalledExactlyOnceWith("https://github.com/login/oauth/authorize?client_id=app")
})

test("GitHub App authorization refuses a different browser account", async () => {
  const request = mountAt("/auth/github-app?user=u1", async () => ({ registrationEnabled: true }), { id: "u2", name: "Bob" })
  await flushPromises()
  expect(view!.get('[role="alert"]').text()).toContain("different DeskFleet account")
  expect(button(view!, "Authorize")).toBeUndefined()
  expect(button(view!, i18n.global.t("auth.differentAccount"))).toBeDefined()
  expect(request).not.toHaveBeenCalledWith("GET", "/api/integrations/github")
})
