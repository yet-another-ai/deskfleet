import { getClient } from "@deskfleet/client/platform"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import type { LocalAgentState } from "@deskfleet/client/local-agent"
import { onboardingPermissions, type OnboardingApi, type OnboardingPermissionsState, type OnboardingState } from "@deskfleet/client/onboarding"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { platformClientKey } from "../../composables/usePlatformClient.ts"
import { i18n } from "../../i18n/index.ts"
import PermissionsSettings from "./PermissionsSettings.vue"

let view: VueWrapper | undefined
afterEach(() => { view?.unmount(); view = undefined; vi.restoreAllMocks() })

function setup(platform: DeskfleetDesktopApi["platform"] = "darwin", localAgent = true, backend: OnboardingState["linuxDesktopBackend"] = platform === "linux" ? "wayland" : undefined) {
  const state: OnboardingState = { step: "complete", permissionSteps: onboardingPermissions(platform, backend, localAgent), linuxDesktopBackend: backend }
  const permissions: OnboardingPermissionsState = {
    localNetwork: "not-requested",
    linuxDesktopBackend: backend,
    fullDiskAccessPermission: { status: "denied" },
    screenCapturePermission: { status: "denied" },
    accessibilityPermission: { status: "granted" },
  }
  const listeners = new Set<(state: LocalAgentState) => void>()
  const onboarding = {
    get: vi.fn(async () => ({ ...state })),
    permissions: vi.fn(async () => ({ ...permissions })),
    requestPermission: vi.fn<OnboardingApi["requestPermission"]>(async kind => kind === "localNetwork" ? { localNetwork: "attempted" } : { ...permissions, [`${kind}Permission`]: { status: "requesting" } }),
    openLocalNetworkSettings: vi.fn(async () => {}),
    advancePermission: vi.fn(async () => state),
    complete: vi.fn(async () => state),
  } satisfies OnboardingApi
  const host: DeskfleetDesktopApi = {
    ...getClient(), platform, onboarding,
    settings: { ...getClient().settings, onChanged(listener) { listeners.add(listener); return () => { listeners.delete(listener) } } },
  }
  return {
    host, state, permissions, onboarding, listeners,
    mount() {
      view = mount(PermissionsSettings, { global: { plugins: [i18n], provide: { [platformClientKey as symbol]: host } } })
      return view
    },
    changed(change: Partial<LocalAgentState> = {}) {
      for (const listener of listeners) listener({ enabled: localAgent, status: localAgent ? "running" : "stopped", ...permissions, ...change })
    },
    changedSnapshot(state: LocalAgentState) {
      for (const listener of listeners) listener(state)
    },
  }
}

function card(kind: string) { return view!.get(`[data-permission="${kind}"]`) }
async function click(text: string) {
  const button = view!.findAll("button").find(button => button.text() === text)
  expect(button, `Button ${text}`).toBeDefined()
  await button!.trigger("click")
  await flushPromises()
}

test("reviews all macOS permissions after welcome and requests them without advancing setup", async () => {
  const app = setup()
  app.mount()
  await flushPromises()
  expect(view!.findAll("h2").map(title => title.text())).toEqual(["Local network", "Full Disk Access", "Screen recording", "Accessibility"])
  expect(card("accessibility").get('[role="status"]').text()).toBe("Access enabled")
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
  await card("screenCapture").get("button").trigger("click")
  await flushPromises()
  expect(app.onboarding.requestPermission).toHaveBeenCalledExactlyOnceWith("screenCapture")
  expect(card("screenCapture").get('[role="status"]').text()).toBe("Waiting for macOS authorization…")
  expect(app.onboarding.advancePermission).not.toHaveBeenCalled()
  expect(app.onboarding.complete).not.toHaveBeenCalled()
})

test("local network requests stay explicit and an attempted request is never shown as a grant", async () => {
  const app = setup()
  app.mount()
  await flushPromises()
  await click("Request access")
  expect(app.onboarding.requestPermission).toHaveBeenCalledExactlyOnceWith("localNetwork")
  expect(card("localNetwork").get('[role="status"]').text()).toBe("Request sent. Check System Settings to confirm access is enabled.")
  await click("Open System Settings")
  expect(app.onboarding.openLocalNetworkSettings).toHaveBeenCalledOnce()
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect(app.onboarding.requestPermission).toHaveBeenCalledOnce()
})

test("rechecks permissions on focus and by request, and permits retry after a failed refresh", async () => {
  const app = setup()
  app.mount()
  await flushPromises()
  app.permissions.fullDiskAccessPermission = { status: "granted" }
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect(card("fullDiskAccess").get('[role="status"]').text()).toBe("Access enabled")
  expect(app.onboarding.permissions).toHaveBeenCalledTimes(2)
  app.onboarding.permissions.mockRejectedValueOnce(new Error("Daemon unavailable"))
  await click(i18n.global.t("permissionsSettings.refresh"))
  expect(view!.get('[role="alert"]').text()).toBe("Daemon unavailable")
  await click(i18n.global.t("permissionsSettings.refresh"))
  expect(view!.find('[role="alert"]').exists()).toBe(false)
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
})

test("keeps newer permission events when an older refresh response arrives", async () => {
  const app = setup()
  let resolve!: (permissions: OnboardingPermissionsState) => void
  app.onboarding.permissions.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  app.mount()
  await flushPromises()
  const stale = { ...app.permissions }
  app.permissions.fullDiskAccessPermission = { status: "granted" }
  app.changed()
  resolve(stale)
  await flushPromises()
  expect(card("fullDiskAccess").get('[role="status"]').text()).toBe("Access enabled")
  view!.unmount()
  view = undefined
  expect(app.listeners.size).toBe(0)
})

test.each(["starting", "stopped", "error"] as const)("a %s lifecycle snapshot preserves known permission decisions", async status => {
  const app = setup()
  app.mount()
  await flushPromises()
  // LocalAgentController clears these fields during startup, shutdown, and errors.
  app.changedSnapshot({
    enabled: true, status, linuxDesktopBackend: undefined,
    fullDiskAccessPermission: undefined, screenCapturePermission: undefined, accessibilityPermission: undefined,
  })
  await flushPromises()
  expect(card("fullDiskAccess").get('[role="status"]').text()).toBe("Access is not enabled yet")
  expect(card("accessibility").get('[role="status"]').text()).toBe("Access enabled")
})

test("a lifecycle-only event does not invalidate a pending permission refresh", async () => {
  const app = setup()
  app.mount()
  await flushPromises()
  let resolve!: (permissions: OnboardingPermissionsState) => void
  app.onboarding.permissions.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect(app.onboarding.permissions).toHaveBeenCalledTimes(2)
  app.changedSnapshot({ enabled: true, status: "starting" })
  resolve({ ...app.permissions, fullDiskAccessPermission: { status: "granted" } })
  await flushPromises()
  expect(card("fullDiskAccess").get('[role="status"]').text()).toBe("Access enabled")
  expect(card("screenCapture").get('[role="status"]').text()).toBe("Access is not enabled yet")
})

test("disabling the local agent during a pending configuration read hides daemon cards despite its stale result", async () => {
  const app = setup()
  app.mount()
  await flushPromises()
  let resolve!: (state: OnboardingState) => void
  app.onboarding.get.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect(app.onboarding.get).toHaveBeenCalledTimes(2)
  app.changedSnapshot({ enabled: false, status: "stopped" })
  await flushPromises()
  expect(view!.findAll("h2").map(title => title.text())).toEqual(["Local network"])
  resolve({ ...app.state })
  await flushPromises()
  expect(view!.findAll("h2").map(title => title.text())).toEqual(["Local network"])
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
})

test("a partial permission event updates its supplied decision and preserves the others", async () => {
  const app = setup()
  app.mount()
  await flushPromises()
  app.changedSnapshot({ enabled: true, status: "running", screenCapturePermission: { status: "granted" } })
  await flushPromises()
  expect(card("screenCapture").get('[role="status"]').text()).toBe("Access enabled")
  expect(card("fullDiskAccess").get('[role="status"]').text()).toBe("Access is not enabled yet")
  expect(card("accessibility").get('[role="status"]').text()).toBe("Access enabled")
})

test("keeps newer daemon events during a permission request and retains the host network result", async () => {
  const app = setup()
  app.mount()
  await flushPromises()
  let resolve!: (permissions: OnboardingPermissionsState) => void
  app.onboarding.requestPermission.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await card("screenCapture").get("button").trigger("click")
  app.permissions.screenCapturePermission = { status: "granted" }
  app.changed()
  resolve({ screenCapturePermission: { status: "requesting" } })
  await flushPromises()
  expect(card("screenCapture").get('[role="status"]').text()).toBe("Access enabled")
  app.onboarding.requestPermission.mockImplementationOnce(async () => {
    app.changed()
    return { localNetwork: "attempted" }
  })
  await click("Request access")
  expect(card("localNetwork").get('[role="status"]').text()).toContain("Request sent.")
})

test("Wayland uses shared consent and blocks duplicate requests while the desktop dialog is open", async () => {
  const app = setup("linux")
  app.permissions.accessibilityPermission = { status: "denied" }
  app.mount()
  await flushPromises()
  expect(view!.findAll("h2").map(title => title.text())).toEqual(["Screen sharing", "Mouse and keyboard control"])
  app.onboarding.requestPermission.mockResolvedValueOnce({
    screenCapturePermission: { status: "requesting" }, accessibilityPermission: { status: "requesting" },
  })
  await card("screenCapture").get("button").trigger("click")
  await flushPromises()
  expect(app.onboarding.requestPermission).toHaveBeenCalledExactlyOnceWith("screenCapture")
  for (const kind of ["screenCapture", "accessibility"]) {
    expect(card(kind).get("button").attributes("disabled")).toBeDefined()
    expect(card(kind).get('[role="status"]').text()).toBe("Waiting for desktop authorization…")
  }
  app.permissions.screenCapturePermission = { status: "denied" }
  app.permissions.accessibilityPermission = { status: "denied" }
  app.changed()
  await flushPromises()
  expect(card("accessibility").get("button").attributes("disabled")).toBeUndefined()
  await card("accessibility").get("button").trigger("click")
  await flushPromises()
  expect(app.onboarding.requestPermission).toHaveBeenLastCalledWith("accessibility")
})

test("Linux follows late backend events and does not restore Wayland cards from a stale refresh", async () => {
  const app = setup("linux")
  let resolve!: (permissions: OnboardingPermissionsState) => void
  app.onboarding.permissions.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  app.mount()
  await flushPromises()
  app.changedSnapshot({ enabled: true, status: "running", linuxDesktopBackend: "x11" })
  resolve({ ...app.permissions })
  await flushPromises()
  expect(view!.findAll("h2")).toHaveLength(0)
  app.changedSnapshot({ enabled: true, status: "running", linuxDesktopBackend: "wayland" })
  await flushPromises()
  expect(view!.findAll("h2")).toHaveLength(2)
})

test("macOS without a local agent only exposes the host network permission", async () => {
  const app = setup("darwin", false)
  app.mount()
  await flushPromises()
  expect(view!.findAll("h2").map(title => title.text())).toEqual(["Local network"])
})

test.each(["win32", "linux"] as const)("%s without permission steps needs no permission requests", async platform => {
  const app = setup(platform, true, platform === "linux" ? "x11" : undefined)
  app.mount()
  await flushPromises()
  expect(view!.findAll("h2")).toHaveLength(0)
  expect(app.onboarding.permissions).not.toHaveBeenCalled()
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
})

test("does not expose permission actions without the desktop onboarding API", async () => {
  const app = setup("web")
  app.host.onboarding = undefined
  app.mount()
  await flushPromises()
  expect(view!.findAll("button")).toHaveLength(0)
  expect(app.listeners.size).toBe(0)
})
