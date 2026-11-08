import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, type Pinia } from "pinia"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"
import { configureClient, getClient } from "@deskfleet/client/platform"
import { HttpError } from "@deskfleet/client/http-central"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import AccountShell from "./AccountShell.vue"
import { i18n } from "./i18n/index.ts"
import { router } from "./router/index.ts"
import { fakeCentral, machineFixture } from "./test/central.ts"

let view: VueWrapper | undefined
let pinia: Pinia
const host = getClient()
const page = () => new DOMWrapper(document.body)
const button = (text: string) => page().findAll("button").find(value => value.text() === text)!
beforeEach(() => { pinia = createPinia(); configureClient({ ...host, platform: "web" }) })
// These routes load on demand. vi.waitFor only polls for 1s, which misses the form while Vite is still compiling them.
beforeAll(async () => {
  await Promise.all([
    import("./views/SiteAdminView.vue"),
    import("./components/settings/SiteSettings.vue"),
    import("./components/settings/SiteIdentitySettings.vue"),
    import("./components/settings/TurnSettings.vue"),
    import("./components/settings/CloudflareTurnSettings.vue"),
    import("./components/settings/EnterpriseTeams.vue"),
    import("./views/NewSessionView.vue"),
    import("./components/account/MachineSurface.vue"),
  ])
})
/** Check the shell as soon as its microtasks render, instead of on a real-time interval. */
async function settled(probe: () => void): Promise<void> {
  let failure: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      probe()
      return
    } catch (reason) {
      failure = reason
    }
    await flushPromises()
  }
  throw failure
}
afterEach(async () => { view?.unmount(); view = undefined; disposePinia(pinia); configureClient(host); await router.replace("/"); vi.restoreAllMocks() })
function mountShell(fake: ReturnType<typeof fakeCentral>, platform: DeskfleetDesktopApi["platform"] = "web"): void {
  const adapter = { ...host, platform, central: fake.central, siteAdministration: platform === "web" ? fake.central : undefined }
  configureClient(adapter)
  view = mount(AccountShell, {
    props: { host: adapter },
    global: { plugins: [pinia, i18n, router] }, attachTo: document.body,
  })
}

test("a site administrator without any Team opens administration from the account menu and saves settings", async () => {
  const fake = fakeCentral({ siteAdmin: true, teams: [] })
  mountShell(fake)
  await flushPromises()
  await page().get('button[aria-label="Ada"]').trigger("click")
  await button("Site administration").trigger("click")
  await settled(() => expect(page().find('[name="site-name"]').exists()).toBe(true))
  expect(router.currentRoute.value.path).toBe("/admin/settings")
  expect(page().get("h1").text()).toBe("Site settings")
  expect(fake.central.siteSettings).toHaveBeenCalledOnce()
  expect(fake.central.turnSettings).not.toHaveBeenCalled()
  await page().get('[name="site-name"]').setValue("  Studio fleet  ")
  await page().get('[name="announcement"]').setValue("Maintenance on Sunday")
  await page().get('[name="terms-of-service-url"]').setValue("  https://example.test/terms  ")
  await page().get('[name="privacy-terms-url"]').setValue("https://example.test/privacy")
  await page().get('[role="switch"]').trigger("click")
  fake.central.updateSiteSettings.mockRejectedValueOnce(new Error("Unable to save settings"))
  await page().get("form").trigger("submit")
  await flushPromises()
  expect(page().get('[role="alert"]').text()).toBe("Unable to save settings")
  expect(document.title).toBe("DeskFleet")
  await page().get("form").trigger("submit")
  await flushPromises()
  expect(fake.central.updateSiteSettings).toHaveBeenLastCalledWith({ siteName: "Studio fleet", announcement: "Maintenance on Sunday", allowTeamCreation: false, termsOfServiceUrl: "https://example.test/terms", privacyTermsUrl: "https://example.test/privacy" })
  expect(view!.text()).toContain("Site settings saved.")
  expect(document.title).toBe("Studio fleet")
  expect(view!.text()).toContain("Maintenance on Sunday")
  await button("Back to app").trigger("click")
  await settled(() => expect(router.currentRoute.value.path).toBe("/"))
  expect(view!.text()).toContain("Join a team using an invitation")
  expect(view!.text()).not.toContain("Create a team")
  expect(fake.central.members).not.toHaveBeenCalled()
})



test("terms URLs can be configured independently and cleared without changing other site settings", async () => {
  const fake = fakeCentral({ siteAdmin: true, teams: [], site: { termsOfServiceUrl: "https://example.test/terms" } })
  await router.push("/admin/settings")
  mountShell(fake)
  await flushPromises()
  expect(page().get<HTMLInputElement>('[name="terms-of-service-url"]').element.value).toBe("https://example.test/terms")
  expect(button("Save").attributes("disabled")).toBeDefined()
  await page().get('[name="terms-of-service-url"]').setValue("")
  await page().get('[name="privacy-terms-url"]').setValue("https://example.test/privacy")
  expect(button("Save").attributes("disabled")).toBeUndefined()
  await page().get("form").trigger("submit")
  await flushPromises()
  expect(fake.central.updateSiteSettings).toHaveBeenLastCalledWith({ siteName: "DeskFleet", announcement: "", allowTeamCreation: true, termsOfServiceUrl: "", privacyTermsUrl: "https://example.test/privacy" })
  expect(button("Save").attributes("disabled")).toBeDefined()
  await page().get('[name="privacy-terms-url"]').setValue("")
  await page().get("form").trigger("submit")
  await flushPromises()
  expect(fake.state.site.termsOfServiceUrl).toBe("")
  expect(fake.state.site.privacyTermsUrl).toBe("")
})

test("administration navigation opens one settings section at a time", async () => {
  const fake = fakeCentral({ siteAdmin: true, teams: [] })
  await router.push("/admin")
  mountShell(fake)
  await settled(() => expect(page().find('[name="site-name"]').exists()).toBe(true))
  expect(fake.central.turnSettings).not.toHaveBeenCalled()
  const nav = page().get('nav[aria-label="Settings sections"]')
  expect(nav.findAll("a").map(link => link.text())).toEqual(["Site settings", "Accounts", "TURN servers", "Cloudflare TURN", "Manual grants"])
  await nav.findAll("a").find(link => link.text() === "Accounts")!.trigger("click")
  await settled(() => expect(page().get("h1").text()).toBe("Accounts"))
  expect(router.currentRoute.value.path).toBe("/admin/accounts")
  expect(fake.central.registrationPolicy).toHaveBeenCalledOnce()
  expect(fake.central.turnSettings).not.toHaveBeenCalled()
  await nav.findAll("a").find(link => link.text() === "TURN servers")!.trigger("click")
  await settled(() => expect(page().get("h1").text()).toBe("TURN servers"))
  expect(fake.central.turnSettings).toHaveBeenCalledOnce()
  expect(fake.central.cloudflareTurnSettings).not.toHaveBeenCalled()
  await nav.findAll("a").find(link => link.text() === "Cloudflare TURN")!.trigger("click")
  await settled(() => expect(page().get("h1").text()).toBe("Cloudflare TURN"))
  expect(fake.central.cloudflareTurnSettings).toHaveBeenCalledOnce()
  await nav.findAll("a").find(link => link.text() === "Manual grants")!.trigger("click")
  await settled(() => expect(page().get("h1").text()).toBe("Manual grants"))
  expect(fake.central.billingTeams).toHaveBeenCalledOnce()
})

test("an ordinary Team admin has no site menu entry and direct navigation never loads admin settings", async () => {
  const fake = fakeCentral()
  mountShell(fake)
  await flushPromises()
  await page().get('button[aria-label="Ada"]').trigger("click")
  expect(page().findAll('[role="menuitem"]').map(item => item.text())).not.toContain("Site administration")
  await page().get('[role="menu"]').trigger("keydown", { key: "Escape" })
  await router.push("/admin")
  await flushPromises()
  expect(page().get('[role="alert"]').text()).toBe("Site administrator access is required.")
  expect(page().find("form").exists()).toBe(false)
  expect(fake.central.siteSettings).not.toHaveBeenCalled()
  expect(fake.central.turnSettings).not.toHaveBeenCalled()
})

test.each(["darwin", "linux", "win32"] as const)("%s keeps public site settings but does not expose administration to a site admin", async platform => {
  const fake = fakeCentral({ siteAdmin: true, teams: [], site: { siteName: "Studio fleet", announcement: "Maintenance on Sunday", allowTeamCreation: false } })
  mountShell(fake, platform)
  await flushPromises()
  expect(document.title).toBe("Studio fleet")
  expect(view!.text()).toContain("Maintenance on Sunday")
  expect(view!.text()).toContain("Join a team using an invitation")
  expect(view!.text()).not.toContain("Create a team")
  await page().get('button[aria-label="Ada"]').trigger("click")
  expect(page().findAll('[role="menuitem"]').map(item => item.text())).not.toContain("Site administration")
  await page().get('[role="menu"]').trigger("keydown", { key: "Escape" })
  await router.push("/admin")
  await flushPromises()
  expect(router.currentRoute.value.path).toBe("/")
  expect(page().find('[name="site-name"]').exists()).toBe(false)
  expect(fake.central.siteSettings).not.toHaveBeenCalled()
  expect(fake.central.updateSiteSettings).not.toHaveBeenCalled()
  expect(fake.central.turnSettings).not.toHaveBeenCalled()
})

test("direct administration navigation handles denied server access and removes the form after role refresh", async () => {
  const fake = fakeCentral({ siteAdmin: true, teams: [] })
  fake.central.siteSettings.mockRejectedValueOnce(new HttpError(403, "Site administrator access was revoked"))
  await router.push("/admin")
  mountShell(fake)
  await flushPromises()
  expect(page().get('[role="alert"]').text()).toBe("Site administrator access was revoked")
  expect(page().find('[name="site-name"]').exists()).toBe(false)
  await button("Try again").trigger("click")
  await flushPromises()
  expect(page().find("form").exists()).toBe(true)
  await page().get('[name="site-name"]').setValue("Unsaved name")
  fake.central.updateSiteSettings.mockRejectedValueOnce(new HttpError(403, "Site administrator access was revoked"))
  await page().get("form").trigger("submit")
  await flushPromises()
  expect(page().get('[role="alert"]').text()).toBe("Site administrator access was revoked")
  expect(page().get<HTMLInputElement>('[name="site-name"]').element.value).toBe("Unsaved name")
  fake.state.siteAdmin = false
  fake.emit({ type: "accountChanged" })
  await flushPromises()
  expect(page().find("form").exists()).toBe(false)
  expect(page().get('[role="alert"]').text()).toBe("Site administrator access is required.")
})

test("team creation stays hidden in the Team menu when disabled", async () => {
  const fake = fakeCentral({ site: { siteName: "Studio", announcement: "", allowTeamCreation: false } })
  mountShell(fake)
  await flushPromises()
  await page().get('button[aria-label="Team"]').trigger("click")
  const entries = page().findAll('[role="menuitem"]').map(item => item.text())
  expect(entries).not.toContain("Create a team")
  expect(entries).toContain("Join a team")
})

test("direct administration navigation is preserved when an existing machine mounts", async () => {
  const fake = fakeCentral({ siteAdmin: true, machines: [machineFixture("m1", "team-1", "Build server", false)] })
  Object.assign(fake.central, {
    catalog: vi.fn(async () => ({ machineId: "m1", lastObservedAt: "2026-10-27T00:00:00Z", snapshot: { teamId: "team-1", machineId: "m1", machineName: "Build server", workspaces: [] } })),
    sessions: vi.fn(async () => []),
    rpc: vi.fn(async () => { throw new Error("Offline") }),
  })
  await router.push("/admin")
  mountShell(fake)
  await settled(() => expect(page().find('[name="site-name"]').exists()).toBe(true))
  expect(router.currentRoute.value.path).toBe("/admin/settings")
  expect(fake.central.siteSettings).toHaveBeenCalledOnce()
})
