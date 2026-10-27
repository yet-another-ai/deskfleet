import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, type Pinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
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
  await flushPromises()
  expect(router.currentRoute.value.path).toBe("/admin")
  expect(page().get("h1").text()).toBe("Site administration")
  expect(fake.central.siteSettings).toHaveBeenCalledOnce()
  await page().get('[name="site-name"]').setValue("  Studio fleet  ")
  await page().get('[name="announcement"]').setValue("Maintenance on Sunday")
  await page().get('[role="switch"]').trigger("click")
  fake.central.updateSiteSettings.mockRejectedValueOnce(new Error("Unable to save settings"))
  await page().get("form").trigger("submit")
  await flushPromises()
  expect(page().get('[role="alert"]').text()).toBe("Unable to save settings")
  expect(document.title).toBe("deskfleet")
  await page().get("form").trigger("submit")
  await flushPromises()
  expect(fake.central.updateSiteSettings).toHaveBeenLastCalledWith({ siteName: "Studio fleet", announcement: "Maintenance on Sunday", allowTeamCreation: false })
  expect(view!.text()).toContain("Site settings saved.")
  expect(document.title).toBe("Studio fleet")
  expect(view!.text()).toContain("Maintenance on Sunday")
  await button("Back to app").trigger("click")
  await flushPromises()
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe("/"))
  expect(view!.text()).toContain("Join a team using an invitation")
  expect(view!.text()).not.toContain("Create a team")
  expect(fake.central.members).not.toHaveBeenCalled()
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
})

test("direct administration navigation handles denied server access and removes the form after role refresh", async () => {
  const fake = fakeCentral({ siteAdmin: true, teams: [] })
  fake.central.siteSettings.mockRejectedValueOnce(new HttpError(403, "Site administrator access was revoked"))
  await router.push("/admin")
  mountShell(fake)
  await flushPromises()
  expect(page().get('[role="alert"]').text()).toBe("Site administrator access was revoked")
  expect(page().find("form").exists()).toBe(false)
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
  await vi.waitFor(() => expect(page().find('[name="site-name"]').exists()).toBe(true))
  expect(router.currentRoute.value.path).toBe("/admin")
  expect(fake.central.siteSettings).toHaveBeenCalledOnce()
})
