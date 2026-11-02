import type { VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import type { HttpCentralClient } from "@deskfleet/client/http-central"
import { getClient } from "@deskfleet/client/platform"

const host = getClient()
let view: VueWrapper | undefined
afterEach(() => {
  view?.unmount()
  view = undefined
  sessionStorage.clear()
  history.replaceState(null, "", "/")
  vi.restoreAllMocks()
})

test.each([
  { path: "/auth/verify", endpoint: "/api/auth/verify", name: "Ada", password: "A sufficiently long password" },
  { path: "/auth/recovery/complete", endpoint: "/api/auth/recovery/complete", password: "A replacement password" },
  { path: "/auth/email/verify", endpoint: "/api/auth/email/verify", user: { id: "u1", name: "Ada", email: "ada@example.test" } },
])("a cold start preserves the mailed token on $path", async ({ path, endpoint, name, password, user }) => {
  // Import after navigation, as a new browser document does. Importing AuthPage
  // before setting the URL hides side effects from its transitive dependencies.
  vi.resetModules()
  const { configureClient } = await import("@deskfleet/client/platform")
  configureClient(host)
  const token = "fresh-mail-token"
  history.replaceState(null, "", `${path}#token=${token}`)
  const { default: AuthPage } = await import("./AuthPage.vue")
  expect(location.hash).toBe(`#token=${token}`)

  const { mount, flushPromises } = await import("@vue/test-utils")
  const { i18n } = await import("../../i18n/index.ts")
  const request = vi.fn(async () => ({ registrationEnabled: true }))
  const api = { request, status: async () => ({ user }) } as unknown as HttpCentralClient
  vi.spyOn(location, "assign").mockImplementation(() => {})
  view = mount(AuthPage, { props: { api }, global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  expect(location.hash).toBe("")
  expect(view.find("form").exists()).toBe(true)
  expect(request).not.toHaveBeenCalledWith("POST", endpoint, expect.anything())
  if (name) await view.get('input[name="name"]').setValue(name)
  if (password) await view.get('input[type="password"]').setValue(password)
  await view.get("form").trigger("submit")
  await flushPromises()
  expect(request).toHaveBeenCalledWith("POST", endpoint, { token, ...(name ? { name } : {}), ...(password ? { password } : {}) })
})
