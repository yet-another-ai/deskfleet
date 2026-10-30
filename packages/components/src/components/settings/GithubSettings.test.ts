import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import type { GithubAppSettings } from "@deskfleet/client/central"
import { accountSessionKey, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import GithubSettings from "./GithubSettings.vue"

let view: VueWrapper | undefined
const settings: GithubAppSettings = { configured: true, manageUrl: "https://github.com/apps/deskfleet/installations/new", authorized: false, login: null, actAsYou: false }
const button = (label: string) => view!.findAll("button").find(value => value.text() === label)!
function setup(initial = settings) {
  const central = {
    githubSettings: vi.fn(async () => ({ ...initial })), manageGithub: vi.fn(async () => {}), authorizeGithubApp: vi.fn(async () => {}),
    setGithubActAsYou: vi.fn(async (actAsYou: boolean) => ({ ...initial, actAsYou })),
  }
  view = mount(GithubSettings, { global: { plugins: [i18n], provide: { [accountSessionKey as symbol]: { central } as unknown as AccountSession } } })
  return central
}
afterEach(() => { view?.unmount(); vi.restoreAllMocks() })

test("opens installation management and authorization, then refreshes the grant on return", async () => {
  const central = setup()
  await flushPromises()
  expect(view!.get('[role="switch"]').attributes("disabled")).toBeDefined()
  await button("Manage GitHub").trigger("click"); await flushPromises()
  expect(central.manageGithub).toHaveBeenCalledOnce()
  await button("Authorize").trigger("click"); await flushPromises()
  expect(central.authorizeGithubApp).toHaveBeenCalledOnce()
  expect(view!.get('[role="status"]').text()).toContain("Complete authorization")
  central.githubSettings.mockResolvedValue({ ...settings, authorized: true, login: "octocat" })
  window.dispatchEvent(new Event("focus")); await flushPromises()
  expect(view!.text()).toContain("Authorized as octocat")
  expect(view!.get('[role="switch"]').attributes("disabled")).toBeUndefined()
  expect(view!.get('[role="switch"]').attributes("aria-checked")).toBe("false")
})

test("persists the switch and preserves its saved value when an update fails", async () => {
  const central = setup({ ...settings, authorized: true, login: "octocat" })
  await flushPromises()
  await view!.get('[role="switch"]').trigger("click"); await flushPromises()
  expect(central.setGithubActAsYou).toHaveBeenCalledExactlyOnceWith(true)
  expect(view!.get('[role="switch"]').attributes("aria-checked")).toBe("true")
  central.setGithubActAsYou.mockRejectedValueOnce(new Error("Unable to save GitHub settings"))
  await view!.get('[role="switch"]').trigger("click"); await flushPromises()
  expect(view!.get('[role="alert"]').text()).toBe("Unable to save GitHub settings")
  expect(view!.get('[role="switch"]').attributes("aria-checked")).toBe("true")
})

test("unconfigured integrations cannot authorize, manage repositories or act as the user", async () => {
  setup({ ...settings, configured: false, manageUrl: null })
  await flushPromises()
  expect(view!.get('[role="status"]').text()).toContain("not configured")
  expect(button("Manage GitHub").attributes("disabled")).toBeDefined()
  expect(button("Authorize").attributes("disabled")).toBeDefined()
  expect(view!.get('[role="switch"]').attributes("disabled")).toBeDefined()
})
