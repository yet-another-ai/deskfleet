import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, disposePinia, type Pinia } from "pinia"
import { getClient } from "@deskfleet/client/platform"
import { getBrowserNotificationPermission, requestBrowserNotificationPermission } from "@deskfleet/client/browser-notifications"
import { i18n } from "./i18n/index.ts"
import AccountShell from "./AccountShell.vue"
import { fakeCentral } from "./test/central.ts"

vi.mock("@deskfleet/client/browser-notifications", () => ({
  getBrowserNotificationPermission: vi.fn(() => "default"),
  requestBrowserNotificationPermission: vi.fn(async () => "granted"),
}))
vi.mock("./composables/useBrowserNotifications.ts", () => ({ useBrowserNotifications: vi.fn() }))

const storageKey = "deskfleet.notifications-onboarding-complete"
let view: VueWrapper | undefined
let pinia: Pinia
beforeEach(() => {
  pinia = createPinia()
  vi.clearAllMocks()
  localStorage.removeItem(storageKey)
  vi.mocked(getBrowserNotificationPermission).mockReturnValue("default")
  vi.mocked(requestBrowserNotificationPermission).mockResolvedValue("granted")
})
afterEach(() => { view?.unmount(); view = undefined; disposePinia(pinia); localStorage.removeItem(storageKey); vi.restoreAllMocks() })

async function render(signedIn = false, platform: "web" | "win32" = "web") {
  const fake = fakeCentral({ signedIn, teams: [] })
  view = mount(AccountShell, { props: { host: { ...getClient(), platform, central: fake.central } }, global: { plugins: [pinia, i18n] } })
  await flushPromises()
  return fake
}

async function click(text: string) {
  const button = view!.findAll("button").find(button => button.text() === text)
  expect(button).toBeDefined()
  await button!.trigger("click")
  await flushPromises()
}

test.each(["granted", "denied", "default"] as const)("web onboarding requests on click and continues after %s", async result => {
  vi.mocked(requestBrowserNotificationPermission).mockResolvedValue(result)
  const fake = await render()
  expect(view!.get("h1").text()).toBe("Stay up to date with your tasks")
  expect(requestBrowserNotificationPermission).not.toHaveBeenCalled()
  expect(localStorage.getItem(storageKey)).toBeNull()
  await click("Enable notifications")
  expect(requestBrowserNotificationPermission).toHaveBeenCalledOnce()
  expect(localStorage.getItem(storageKey)).toBe("true")
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
  expect(fake.central.login).not.toHaveBeenCalled()
})

test("signed-in users can skip the one-time notification prompt across remounts", async () => {
  await render(true)
  expect(view!.get("h1").text()).toBe("Stay up to date with your tasks")
  await click("Skip for now")
  expect(requestBrowserNotificationPermission).not.toHaveBeenCalled()
  expect(localStorage.getItem(storageKey)).toBe("true")
  expect(view!.text()).toContain("Welcome, Ada")
  view!.unmount()
  await render(true)
  expect(view!.text()).toContain("Welcome, Ada")
  expect(view!.text()).not.toContain("Stay up to date with your tasks")
})

test("the click requests permission synchronously and waits for the browser prompt", async () => {
  let finish!: (permission: NotificationPermission) => void
  vi.mocked(requestBrowserNotificationPermission).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await render()
  const enable = view!.findAll("button").find(button => button.text() === "Enable notifications")!
  const element = enable.element as HTMLButtonElement
  element.click()
  expect(requestBrowserNotificationPermission).toHaveBeenCalledOnce()
  await flushPromises()
  expect(enable.attributes("disabled")).toBeDefined()
  await click("Skip for now")
  expect(localStorage.getItem(storageKey)).toBeNull()
  expect(view!.get("h1").text()).toBe("Stay up to date with your tasks")
  finish("default")
  await flushPromises()
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
})

test.each(["granted", "denied", "unsupported"] as const)("web onboarding omits a redundant %s permission prompt", async permission => {
  vi.mocked(getBrowserNotificationPermission).mockReturnValue(permission)
  await render()
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
  expect(requestBrowserNotificationPermission).not.toHaveBeenCalled()
  expect(localStorage.getItem(storageKey)).toBeNull()
})

test("a failed request offers retry and skip without persisting completion", async () => {
  vi.mocked(requestBrowserNotificationPermission).mockRejectedValueOnce(new Error("Permission unavailable"))
  await render()
  await click("Enable notifications")
  expect(view!.get('[role="alert"]').text()).toBe("Permission unavailable")
  expect(localStorage.getItem(storageKey)).toBeNull()
  expect(view!.findAll("button").filter(button => ["Enable notifications", "Skip for now"].includes(button.text())).every(button => button.attributes("disabled") === undefined)).toBe(true)
  await click("Enable notifications")
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
  expect(localStorage.getItem(storageKey)).toBe("true")
})

test("desktop sign-in does not ask for browser notification permission", async () => {
  await render(false, "win32")
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
  expect(getBrowserNotificationPermission).not.toHaveBeenCalled()
  expect(requestBrowserNotificationPermission).not.toHaveBeenCalled()
  expect(localStorage.getItem(storageKey)).toBeNull()
})
