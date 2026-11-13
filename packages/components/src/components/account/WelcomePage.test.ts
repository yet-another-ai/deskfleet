import { getClient } from "@deskfleet/client/platform"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import type { LocalAgentState } from "@deskfleet/client/local-agent"
import type { OnboardingApi, OnboardingPermissionsState, OnboardingState } from "@deskfleet/client/onboarding"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { ref } from "vue"
import { afterEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import WelcomePage from "./WelcomePage.vue"

vi.mock("../../composables/useAccountSession.ts", () => ({
  useAccountSession: () => ({ notice: ref(), account: ref({}), site: ref(), signIn: vi.fn() }),
}))

let view: VueWrapper | undefined
afterEach(() => { view?.unmount(); view = undefined; vi.restoreAllMocks() })

function setup(step: "screenCapture" | "accessibility" = "screenCapture") {
  const state: OnboardingState = { step, permissionSteps: ["screenCapture", "accessibility"], linuxDesktopBackend: "wayland" }
  const permissions: OnboardingPermissionsState = {
    linuxDesktopBackend: "wayland",
    screenCapturePermission: { status: "granted" },
    accessibilityPermission: { status: "granted" },
  }
  const listeners = new Set<(state: LocalAgentState) => void>()
  const onboarding = {
    get: vi.fn(async () => state),
    permissions: vi.fn(async () => ({ ...permissions })),
    requestPermission: vi.fn<OnboardingApi["requestPermission"]>(async () => ({
      screenCapturePermission: { status: "requesting" }, accessibilityPermission: { status: "requesting" },
    })),
    openLocalNetworkSettings: vi.fn(async () => {}),
    advancePermission: vi.fn(async () => ({ ...state, step: "accessibility" as const })),
    complete: vi.fn(async () => state),
  } satisfies OnboardingApi
  const host: DeskfleetDesktopApi = {
    ...getClient(), platform: "linux", onboarding,
    settings: { ...getClient().settings, onChanged(listener) { listeners.add(listener); return () => { listeners.delete(listener) } } },
  }
  return {
    permissions, onboarding,
    mount() {
      view = mount(WelcomePage, { props: { host, state }, global: { plugins: [i18n] } })
      return view
    },
    changed() {
      for (const listener of listeners) listener({ enabled: true, status: "running", ...permissions })
    },
  }
}

function button(text: string) {
  const found = view!.findAll("button").find(button => button.text() === text)
  expect(found, `Button ${text}`).toBeDefined()
  return found!
}

test("welcome explains selecting every screen and can replace an existing Wayland grant", async () => {
  const app = setup()
  app.mount()
  await flushPromises()
  expect(view!.text()).toContain("select every monitor you want to access remotely")
  expect(view!.text()).toContain("Only selected screens appear remotely")
  expect(view!.text()).toContain("reuses this selection when you reconnect")
  expect(view!.text()).toContain("stops current remote viewing and control")
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  await button(i18n.global.t("welcome.checkAgain")).trigger("click")
  await flushPromises()
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()

  let resolve!: (permissions: OnboardingPermissionsState) => void
  app.onboarding.requestPermission.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await button("Choose shared screens again").trigger("click")
  expect(button("Choose shared screens again").attributes("disabled")).toBeDefined()
  await button("Choose shared screens again").trigger("click")
  expect(app.onboarding.requestPermission).toHaveBeenCalledExactlyOnceWith("screenCapture")
  resolve({ screenCapturePermission: { status: "requesting" }, accessibilityPermission: { status: "requesting" } })
  await flushPromises()
  expect(button("Choose shared screens").attributes("disabled")).toBeDefined()
  expect(view!.get('[role="status"]').text()).toBe("Waiting for desktop authorization…")
  expect(app.onboarding.advancePermission).not.toHaveBeenCalled()
  app.changed()
  await flushPromises()
  expect(button("Choose shared screens again").attributes("disabled")).toBeUndefined()
  await button(i18n.global.t("welcome.continue")).trigger("click")
  expect(app.onboarding.advancePermission).toHaveBeenCalledExactlyOnceWith("screenCapture")
})

test("welcome shows monitor guidance while the initial authorization dialog is open", async () => {
  const app = setup()
  app.permissions.screenCapturePermission = { status: "requesting" }
  app.permissions.accessibilityPermission = { status: "requesting" }
  app.mount()
  await flushPromises()
  expect(view!.text()).toContain("select every monitor you want to access remotely")
  expect(button("Choose shared screens").attributes("disabled")).toBeDefined()
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
})

test("welcome control step points to permission settings without requesting another screen grant", async () => {
  const app = setup("accessibility")
  app.mount()
  await flushPromises()
  expect(view!.text()).toContain("Settings → Permissions → Screen sharing")
  expect(view!.text()).not.toContain("Choose shared screens again")
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
})
