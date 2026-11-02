import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, disposePinia, type Pinia } from "pinia"
import { getClient } from "@deskfleet/client/platform"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import type { DesktopPermissionsState, LocalAgentState } from "@deskfleet/client/local-agent"
import { onboardingPermissions, type OnboardingApi, type OnboardingPermission, type OnboardingPermissionsState, type OnboardingState, type OnboardingStep } from "@deskfleet/client/onboarding"
import { i18n } from "./i18n/index.ts"
import AccountShell from "./AccountShell.vue"
import { fakeCentral } from "./test/central.ts"

let view: VueWrapper | undefined
let pinia: Pinia
beforeEach(() => { pinia = createPinia() })
afterEach(() => { view?.unmount(); view = undefined; disposePinia(pinia); vi.restoreAllMocks() })

function setup(initialStep: OnboardingStep = "fullDiskAccess", signedIn = false, platform: DeskfleetDesktopApi["platform"] = "darwin", localAgent = true) {
  const fake = fakeCentral({ signedIn, teams: [] })
  const state: OnboardingState = {
    step: initialStep,
    permissionSteps: onboardingPermissions(platform, platform === "linux" ? "wayland" : undefined, localAgent),
    ...(platform === "linux" ? { linuxDesktopBackend: "wayland" as const } : {}),
  }
  const permissions: OnboardingPermissionsState & DesktopPermissionsState = {
    localNetwork: "not-requested",
    fullDiskAccessPermission: { status: platform === "linux" ? "not-required" : "denied" },
    screenCapturePermission: { status: "denied" },
    accessibilityPermission: { status: "denied" },
    ...(platform === "win32" ? { windowsDesktopService: { available: true, installed: false, running: false } } : {}),
  }
  const listeners = new Set<(state: LocalAgentState) => void>()
  const application = { restart: vi.fn(async () => {}) }
  const order = state.permissionSteps
  const next = (step: OnboardingStep) => { state.step = step; return { ...state } }
  const onboarding = {
    get: vi.fn(async () => ({ ...state })),
    permissions: vi.fn(async () => ({ ...permissions })),
    requestPermission: vi.fn(async (kind: OnboardingPermission) => {
      if (kind === "localNetwork") permissions.localNetwork = "attempted"
      else if (kind === "windowsDesktopService") permissions.windowsDesktopService = { available: true, installed: true, running: true }
      else permissions[`${kind}Permission`] = { status: "requesting" }
      if (platform === "linux") {
        permissions.screenCapturePermission = { status: "requesting" }
        permissions.accessibilityPermission = { status: "requesting" }
      }
      return { ...permissions }
    }),
    openLocalNetworkSettings: vi.fn(async () => {}),
    advancePermission: vi.fn(async (kind: OnboardingPermission) => next(order[order.indexOf(kind) + 1] ?? "account")),
    complete: vi.fn(async () => next("complete")),
  } satisfies OnboardingApi
  const host = {
    ...getClient(), platform, central: fake.central, onboarding, application,
    settings: { ...getClient().settings, onChanged: (listener: (state: LocalAgentState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
  }
  return {
    fake, state, permissions, onboarding, application, listeners,
    mount() { view = mount(AccountShell, { props: { host }, global: { plugins: [pinia, i18n] }, attachTo: document.body }) },
    changed() { for (const listener of listeners) listener({ enabled: true, status: "running", ...permissions }) },
  }
}

test("macOS permission steps offer a complete application restart", async () => {
  const app = setup("accessibility")
  app.mount()
  await flushPromises()
  await click("Restart DeskFleet")
  expect(app.application.restart).toHaveBeenCalledOnce()

  view!.unmount()
  const localNetwork = setup("localNetwork")
  localNetwork.mount()
  await flushPromises()
  await click("Restart DeskFleet")
  expect(localNetwork.application.restart).toHaveBeenCalledOnce()

  view!.unmount()
  const linux = setup("screenCapture", false, "linux")
  linux.mount()
  await flushPromises()
  expect(view!.findAll("button").map(button => button.text())).not.toContain("Restart DeskFleet")
})

async function click(text: string): Promise<void> {
  const button = view!.findAll("button").find(value => value.text() === text)
  expect(button, `Button ${text}`).toBeDefined()
  await button!.trigger("click")
  await flushPromises()
}

async function submit(): Promise<void> {
  await view!.get("form").trigger("submit")
  await flushPromises()
}

test("Windows welcome checks service status silently and only enables it on request", async () => {
  const app = setup("windowsDesktopService", false, "win32")
  app.mount()
  await flushPromises()
  expect(view!.findAll("ol li").map(item => item.text())).toEqual(["Remote control while locked", "Your account"])
  expect(view!.get("h1").text()).toBe("Remote control while locked")
  expect(view!.text()).toContain("administrator approval")
  expect(view!.text()).not.toMatch(/macOS|System Settings|Full Disk Access/u)
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect(app.onboarding.permissions).toHaveBeenCalledTimes(2)
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
  await click("Enable locked-session control")
  expect(app.onboarding.requestPermission).toHaveBeenCalledExactlyOnceWith("windowsDesktopService")
  expect(view!.get('[role="status"]').text()).toBe("Ready for remote control while locked")
  await click("Continue")
  expect(app.onboarding.advancePermission).toHaveBeenCalledExactlyOnceWith("windowsDesktopService")
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
})

test("Windows service setup prevents repeated requests and skipping while UAC is pending", async () => {
  const app = setup("windowsDesktopService", false, "win32")
  let finish!: (value: OnboardingPermissionsState & DesktopPermissionsState) => void
  app.onboarding.requestPermission.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  app.mount()
  await flushPromises()
  await click("Enable locked-session control")
  expect(view!.get('[role="status"]').text()).toBe("Waiting for administrator approval…")
  for (const button of view!.findAll("button")) expect(button.attributes("disabled")).toBeDefined()
  await click("Enable locked-session control")
  await click("Skip for now")
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect(app.onboarding.requestPermission).toHaveBeenCalledTimes(1)
  expect(app.onboarding.advancePermission).not.toHaveBeenCalled()
  expect(app.onboarding.permissions).toHaveBeenCalledTimes(1)
  app.changed() // Daemon permission events must not invalidate host service results.
  finish({ ...app.permissions, windowsDesktopService: { available: true, installed: true, running: true } })
  await flushPromises()
  expect(view!.get('[role="status"]').text()).toBe("Ready for remote control while locked")
})

test("cancelled Windows service elevation stays on the step and can be retried", async () => {
  const app = setup("windowsDesktopService", false, "win32")
  app.onboarding.requestPermission.mockRejectedValueOnce(new Error("Administrator approval was cancelled"))
  app.mount()
  await flushPromises()
  await click("Enable locked-session control")
  expect(view!.get('[role="alert"]').text()).toContain("cancelled")
  expect(app.onboarding.advancePermission).not.toHaveBeenCalled()
  await click("Enable locked-session control")
  expect(app.onboarding.requestPermission).toHaveBeenCalledTimes(2)
  expect(view!.find('[role="alert"]').exists()).toBe(false)
  expect(view!.get('[role="status"]').text()).toBe("Ready for remote control while locked")
})

test("Windows welcome starts an installed stopped service and accepts an already running service", async () => {
  const app = setup("windowsDesktopService", false, "win32")
  app.permissions.windowsDesktopService = { available: true, installed: true, running: false }
  app.mount()
  await flushPromises()
  expect(view!.get('[role="status"]').text()).toBe("Installed, but not running")
  await click("Start service")
  expect(app.onboarding.requestPermission).toHaveBeenCalledExactlyOnceWith("windowsDesktopService")
  view!.unmount()
  app.mount()
  await flushPromises()
  expect(view!.get('[role="status"]').text()).toBe("Ready for remote control while locked")
  expect(view!.findAll("button").map(button => button.text())).not.toContain("Enable locked-session control")
  await click("Continue")
  expect(app.onboarding.requestPermission).toHaveBeenCalledOnce()
})

test("an unavailable Windows helper explains the limitation and can skip to account", async () => {
  const app = setup("windowsDesktopService", false, "win32")
  app.permissions.windowsDesktopService = { available: false, installed: false, running: false }
  app.mount()
  await flushPromises()
  expect(view!.get('[role="status"]').text()).toContain("does not include the Windows desktop service helper")
  expect(view!.findAll("button").map(button => button.text())).not.toContain("Enable locked-session control")
  await click("Skip for now")
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
  expect(app.onboarding.advancePermission).toHaveBeenCalledExactlyOnceWith("windowsDesktopService")
})

test("Windows welcome can skip service installation even when the helper is available", async () => {
  const app = setup("windowsDesktopService", false, "win32")
  app.mount()
  await flushPromises()
  await click("Skip for now")
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
})

test("Windows welcome retries a failed silent status check without requesting elevation", async () => {
  const app = setup("windowsDesktopService", false, "win32")
  app.onboarding.permissions.mockRejectedValueOnce(new Error("Could not read service status"))
  app.mount()
  await flushPromises()
  expect(view!.get('[role="alert"]').text()).toBe("Could not read service status")
  await click("Check again")
  expect(view!.find('[role="alert"]').exists()).toBe(false)
  expect(view!.get('[role="status"]').text()).toBe("Not enabled")
  expect(app.onboarding.permissions).toHaveBeenCalledTimes(2)
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
})

test("Windows service status remains authoritative when daemon permissions change during the read", async () => {
  const app = setup("windowsDesktopService", false, "win32")
  let finish!: (value: OnboardingPermissionsState & DesktopPermissionsState) => void
  app.onboarding.permissions.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  app.mount()
  await flushPromises()
  app.changed()
  finish({ ...app.permissions, windowsDesktopService: { available: true, installed: true, running: true } })
  await flushPromises()
  expect(view!.get('[role="status"]').text()).toBe("Ready for remote control while locked")
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
})

test("Windows without a local agent and completed setup show account without service requests", async () => {
  for (const [step, localAgent] of [["account", false], ["complete", true]] as const) {
    const app = setup(step, false, "win32", localAgent)
    app.mount()
    await flushPromises()
    expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
    expect(view!.findAll("ol li").map(item => item.text())).toEqual(["Your account"])
    expect(app.onboarding.permissions).not.toHaveBeenCalled()
    expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
    view!.unmount()
    view = undefined
  }
})

test("local network access is requested only by its button and an attempt is never shown as granted", async () => {
  const app = setup("localNetwork")
  app.mount()
  await flushPromises()
  expect(view!.get("h1").text()).toBe("Local network")
  expect(view!.text()).toContain("Step 1 of 5")
  expect(view!.findAll("button").map(button => button.text())).not.toContain("Check again")
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
  expect(app.onboarding.permissions).toHaveBeenCalledOnce()

  let resolve!: (permissions: OnboardingPermissionsState & DesktopPermissionsState) => void
  app.onboarding.requestPermission.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await click("Request access")
  expect(app.onboarding.requestPermission).toHaveBeenCalledExactlyOnceWith("localNetwork")
  app.changed()
  resolve({ ...app.permissions, localNetwork: "attempted" })
  await flushPromises()
  expect(view!.get('[role="status"]').text()).toBe("Request sent. Check System Settings to confirm access is enabled.")
  expect(view!.get('[role="status"]').text()).not.toBe("Access enabled")
  await click("Open System Settings")
  expect(app.onboarding.openLocalNetworkSettings).toHaveBeenCalledOnce()
  expect(app.onboarding.requestPermission).toHaveBeenCalledOnce()
  await click("Continue")
  expect(app.onboarding.advancePermission).toHaveBeenCalledExactlyOnceWith("localNetwork")
  expect(view!.get("h1").text()).toBe("Full Disk Access")
})

test("an unavailable local network request can continue setup without a grant", async () => {
  const app = setup("localNetwork")
  app.onboarding.requestPermission.mockImplementationOnce(async () => ({ ...app.permissions, localNetwork: "unavailable" }))
  app.mount()
  await flushPromises()
  await click("Request access")
  expect(view!.get('[role="status"]').text()).toBe("Could not request access. Connect to Wi-Fi or Ethernet and try again, or check access in System Settings.")
  await click("Continue")
  expect(view!.get("h1").text()).toBe("Full Disk Access")
})

test("macOS without a local agent uses the host's network-only steps and can skip the request", async () => {
  const app = setup("localNetwork", false, "darwin", false)
  app.mount()
  await flushPromises()
  expect(view!.findAll("ol li").map(item => item.text())).toEqual(["Local network", "Your account"])
  await click("Skip for now")
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
  expect(app.onboarding.advancePermission).toHaveBeenCalledExactlyOnceWith("localNetwork")
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
  await submit()
  expect(app.onboarding.complete).toHaveBeenCalledOnce()
  expect(view!.text()).toContain("Welcome, Ada")
})

test("welcome guides each permission and finishes only after successful sign-in without server configuration", async () => {
  const app = setup()
  app.mount()
  await flushPromises()
  expect(view!.get("h1").text()).toBe("Full Disk Access")
  expect(view!.find('[name="server-url"]').exists()).toBe(false)
  expect(view!.findAll("ol li").map(item => item.text())).toEqual(["Local network", "Full Disk Access", "Screen recording", "Mouse and keyboard control", "Your account"])
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
  await click("Enable access")
  expect(app.onboarding.requestPermission).toHaveBeenCalledExactlyOnceWith("fullDiskAccess")
  expect(view!.get('[role="status"]').text()).toBe("Waiting for macOS authorization…")
  app.permissions.fullDiskAccessPermission = { status: "granted" }
  app.changed()
  await flushPromises()
  await click("Continue")
  expect(view!.get("h1").text()).toBe("Screen recording")
  await click("Skip for now")
  expect(view!.get("h1").text()).toBe("Mouse and keyboard control")
  await click("Skip for now")
  expect(app.onboarding.advancePermission.mock.calls).toEqual([["fullDiskAccess"], ["screenCapture"], ["accessibility"]])
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
  expect(view!.find('input[type="url"]').exists()).toBe(false)
  app.fake.central.login.mockRejectedValueOnce(new Error("Sign-in cancelled"))
  await submit()
  expect(view!.get('[role="alert"]').text()).toBe("Sign-in cancelled")
  expect(app.onboarding.complete).not.toHaveBeenCalled()
  await submit()
  expect(app.fake.central.login).toHaveBeenCalledTimes(2)
  expect(app.onboarding.complete).toHaveBeenCalledOnce()
  expect(view!.text()).toContain("Welcome, Ada")
  expect(app.listeners.size).toBe(0)
})

test("signed-in users resume the saved permission, refresh on focus, and can retry completing setup", async () => {
  const app = setup("screenCapture", true)
  app.mount()
  await flushPromises()
  expect(view!.get("h1").text()).toBe("Screen recording")
  expect(view!.text()).not.toContain("Welcome, Ada")
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
  app.permissions.screenCapturePermission = { status: "granted" }
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect(view!.get('[role="status"]').text()).toBe("Access enabled")
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
  await click("Continue")
  view!.unmount()
  app.mount()
  await flushPromises()
  expect(view!.get("h1").text()).toBe("Mouse and keyboard control")
  await click("Skip for now")
  app.onboarding.complete.mockRejectedValueOnce(new Error("Cannot save setup"))
  await submit()
  expect(view!.get('[role="alert"]').text()).toBe("Cannot save setup")
  expect(view!.text()).not.toContain("Welcome, Ada")
  await submit()
  expect(app.fake.central.login).not.toHaveBeenCalled()
  expect(view!.text()).toContain("Welcome, Ada")
})

test("advancing a permission refreshes the newly displayed step after the action finishes", async () => {
  const app = setup()
  app.mount()
  await flushPromises()
  const reads = app.onboarding.permissions.mock.calls.length
  await click("Skip for now")
  expect(view!.get("h1").text()).toBe("Screen recording")
  expect(app.onboarding.permissions).toHaveBeenCalledTimes(reads + 1)
})

test("Linux welcome shows the shared startup authorization and continues through both granted steps", async () => {
  const app = setup("screenCapture", false, "linux")
  app.permissions.screenCapturePermission = { status: "requesting" }
  app.permissions.accessibilityPermission = { status: "requesting" }
  app.mount()
  await flushPromises()
  expect(view!.findAll("ol li").map(item => item.text())).toEqual([
    "Screen sharing", "Mouse and keyboard control", "Your account",
  ])
  expect(view!.get("h1").text()).toBe("Screen sharing")
  expect(view!.text()).toContain("Step 1 of 3")
  expect(view!.get('[role="status"]').text()).toBe("Waiting for desktop authorization…")
  expect(view!.text()).not.toMatch(/macOS|System Settings|Full Disk Access|system audio|quit and reopen/u)
  for (const text of ["Retry access", "Skip for now"]) {
    const button = view!.findAll("button").find(button => button.text() === text)!
    expect(button.attributes("disabled")).toBeDefined()
    await button.trigger("click")
  }
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
  expect(app.onboarding.advancePermission).not.toHaveBeenCalled()
  app.permissions.screenCapturePermission = { status: "granted" }
  app.permissions.accessibilityPermission = { status: "granted" }
  app.changed()
  await flushPromises()
  await click("Continue")
  expect(view!.get("h1").text()).toBe("Mouse and keyboard control")
  expect(view!.text()).toContain("Step 2 of 3")
  expect(view!.get('[role="status"]').text()).toBe("Access enabled")
  await click("Continue")
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
  expect(app.onboarding.advancePermission.mock.calls).toEqual([["screenCapture"], ["accessibility"]])
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
})

test("Linux denied screen sharing can retry the combined authorization without duplicate requests", async () => {
  const app = setup("screenCapture", false, "linux")
  app.mount()
  await flushPromises()
  expect(view!.get('[role="status"]').text()).toBe("Access is not enabled yet")
  await click("Retry access")
  await click("Retry access")
  expect(app.onboarding.requestPermission).toHaveBeenCalledExactlyOnceWith("screenCapture")
  expect(view!.get('[role="status"]').text()).toBe("Waiting for desktop authorization…")
  app.permissions.screenCapturePermission = { status: "denied" }
  app.permissions.accessibilityPermission = { status: "denied" }
  app.changed()
  await flushPromises()
  await click("Retry access")
  expect(app.onboarding.requestPermission).toHaveBeenCalledTimes(2)
  app.permissions.screenCapturePermission = { status: "granted" }
  app.permissions.accessibilityPermission = { status: "granted" }
  app.changed()
  await flushPromises()
  expect(view!.get('[role="status"]').text()).toBe("Access enabled")
})

test("Linux capture-only access continues to mouse and keyboard retry without requesting screen access again", async () => {
  const app = setup("screenCapture", false, "linux")
  app.permissions.screenCapturePermission = { status: "granted" }
  app.mount()
  await flushPromises()
  await click("Continue")
  expect(view!.get("h1").text()).toBe("Mouse and keyboard control")
  expect(view!.get('[role="status"]').text()).toBe("Access is not enabled yet")
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
  await click("Retry access")
  expect(app.onboarding.requestPermission).toHaveBeenCalledExactlyOnceWith("accessibility")
})

test("Linux can retry access when the initial permission check fails", async () => {
  const app = setup("screenCapture", false, "linux")
  app.onboarding.permissions.mockRejectedValueOnce(new Error("Could not read desktop access"))
  app.mount()
  await flushPromises()
  expect(view!.get('[role="alert"]').text()).toBe("Could not read desktop access")
  await click("Retry access")
  expect(app.onboarding.requestPermission).toHaveBeenCalledExactlyOnceWith("screenCapture")
  expect(view!.get('[role="status"]').text()).toBe("Waiting for desktop authorization…")
})

test("Linux permission setup can skip unavailable sharing and resume mouse and keyboard access", async () => {
  const app = setup("screenCapture", true, "linux")
  app.permissions.screenCapturePermission = { status: "error", error: "Desktop authorization unavailable" }
  app.mount()
  await flushPromises()
  expect(view!.get('[role="alert"]').text()).toBe("Desktop authorization unavailable")
  await click("Skip for now")
  view!.unmount()
  app.mount()
  await flushPromises()
  expect(view!.get("h1").text()).toBe("Mouse and keyboard control")
  expect(view!.text()).not.toMatch(/macOS|System Settings|Full Disk Access/u)
  app.permissions.accessibilityPermission = { status: "granted" }
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect(view!.get('[role="status"]').text()).toBe("Access enabled")
  await click("Continue")
  await submit()
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
  expect(app.fake.central.login).not.toHaveBeenCalled()
  expect(view!.text()).toContain("Welcome, Ada")
})

test("setup loading and failure never reveal the signed-in application, and retry resumes setup", async () => {
  const app = setup("fullDiskAccess", true)
  let reject!: (reason: Error) => void
  app.onboarding.get.mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise }))
  app.mount()
  await flushPromises()
  expect(view!.get('[role="status"]').text()).toBe("Loading DeskFleet…")
  expect(view!.text()).not.toContain("Welcome, Ada")
  reject(new Error("Cannot load setup"))
  await flushPromises()
  expect(view!.get('[role="alert"]').text()).toBe("Cannot load setup")
  await click("Try again")
  expect(view!.get("h1").text()).toBe("Full Disk Access")
})

test("completed setup shows the same welcome sign-in without repeating permission guidance", async () => {
  const app = setup("complete")
  app.mount()
  await flushPromises()
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
  expect(view!.text()).toContain("Welcome to DeskFleet")
  expect(view!.text()).not.toContain("Full Disk Access")
  expect(view!.find('input[type="url"]').exists()).toBe(false)
  await submit()
  expect(app.onboarding.permissions).not.toHaveBeenCalled()
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
  expect(app.onboarding.complete).not.toHaveBeenCalled()
  expect(view!.text()).toContain("Welcome, Ada")
})

test("an account-changed event during login cannot bypass saving completed onboarding", async () => {
  const app = setup("account")
  let resolve!: (state: OnboardingState) => void
  app.onboarding.complete.mockImplementationOnce(() => new Promise(resolvePromise => { resolve = resolvePromise }))
  app.fake.central.login.mockImplementationOnce(async () => {
    app.fake.state.signedIn = true
    app.fake.emit({ type: "accountChanged" })
  })
  app.mount()
  await flushPromises()
  await submit()
  expect(app.onboarding.complete).toHaveBeenCalledOnce()
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
  expect(view!.text()).not.toContain("Welcome, Ada")
  resolve({ step: "complete", permissionSteps: [] })
  await flushPromises()
  expect(view!.text()).toContain("Welcome, Ada")
})

for (const platform of ["darwin", "linux"] as const) test(`${platform} permission events win over an older request response, and an active OS prompt cannot be skipped`, async () => {
  const kind = platform === "linux" ? "screenCapture" : "fullDiskAccess"
  const app = setup(kind, false, platform)
  let resolve!: (state: DesktopPermissionsState) => void
  app.onboarding.requestPermission.mockImplementationOnce(() => new Promise(resolvePromise => { resolve = resolvePromise }))
  app.mount()
  await flushPromises()
  await click(platform === "linux" ? "Retry access" : "Enable access")
  app.permissions[`${kind}Permission`] = { status: "requesting" }
  app.changed()
  await flushPromises()
  const skip = view!.findAll("button").find(button => button.text() === "Skip for now")!
  expect(skip.attributes("disabled")).toBeDefined()
  await skip.trigger("click")
  expect(app.onboarding.advancePermission).not.toHaveBeenCalled()
  const stale = { ...app.permissions }
  app.permissions[`${kind}Permission`] = { status: "granted" }
  app.changed()
  resolve(stale)
  await flushPromises()
  expect(view!.get('[role="status"]').text()).toBe("Access enabled")
  await click("Continue")
  expect(view!.get("h1").text()).toBe(platform === "linux" ? "Mouse and keyboard control" : "Screen recording")
})


test.each(["x11", null] as const)("Linux %s welcome goes directly to account without Portal guidance", async backend => {
  const app = setup("account", false, "linux")
  app.state.linuxDesktopBackend = backend
  app.state.permissionSteps = []
  app.permissions.linuxDesktopBackend = backend
  app.permissions.screenCapturePermission = { status: "not-required" }
  app.permissions.accessibilityPermission = { status: "not-required" }
  app.mount()
  await flushPromises()
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
  expect(view!.findAll("ol li").map(item => item.text())).toEqual(["Your account"])
  expect(view!.text()).not.toMatch(/desktop authorization|sharing dialog|Screen sharing|Mouse and keyboard control/u)
  expect(app.onboarding.permissions).not.toHaveBeenCalled()
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
})

test("Linux welcome follows X11 discovered while retrying its initial permission refresh", async () => {
  const app = setup("screenCapture", false, "linux")
  app.state.linuxDesktopBackend = undefined
  let resolve!: (permissions: DesktopPermissionsState) => void
  app.onboarding.permissions.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  app.mount()
  await flushPromises()
  expect(view!.get("h1").text()).toBe("Screen sharing")

  app.state.linuxDesktopBackend = "x11"
  app.state.permissionSteps = []
  app.state.step = "account"
  resolve({ ...app.permissions, linuxDesktopBackend: "x11", screenCapturePermission: { status: "not-required" }, accessibilityPermission: { status: "not-required" } })
  await flushPromises()
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
  expect(view!.findAll("ol li").map(item => item.text())).toEqual(["Your account"])
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
  expect(app.onboarding.advancePermission).not.toHaveBeenCalled()
  await submit()
  expect(app.onboarding.complete).toHaveBeenCalledOnce()
  expect(view!.text()).toContain("Welcome, Ada")
})

test("Linux welcome reconciles a late X11 hello after a failed permission refresh", async () => {
  const app = setup("screenCapture", false, "linux")
  app.state.linuxDesktopBackend = undefined
  app.onboarding.permissions.mockRejectedValueOnce(new Error("Local Agent startup failed"))
  app.mount()
  await flushPromises()
  expect(view!.get('[role="alert"]').text()).toBe("Local Agent startup failed")

  app.state.linuxDesktopBackend = "x11"
  app.state.permissionSteps = []
  app.state.step = "account"
  app.permissions.linuxDesktopBackend = "x11"
  app.changed()
  await flushPromises()
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
  expect(view!.find('[role="alert"]').exists()).toBe(false)
  expect(view!.findAll("ol li").map(item => item.text())).toEqual(["Your account"])
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
})

test("Linux account keeps a sign-in error when reconcile only discovers the backend", async () => {
  const app = setup("account", false, "linux")
  app.state.linuxDesktopBackend = undefined
  app.permissions.linuxDesktopBackend = undefined
  app.permissions.screenCapturePermission = { status: "not-required" }
  app.permissions.accessibilityPermission = { status: "not-required" }
  app.mount()
  await flushPromises()
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
  app.fake.central.login.mockRejectedValueOnce(new Error("Sign-in cancelled"))
  const reads = app.onboarding.get.mock.calls.length
  // Failed first-run acts always reconcile; a late hello may only add the backend.
  app.onboarding.get.mockImplementationOnce(async () => {
    app.state.linuxDesktopBackend = "x11"
    app.state.permissionSteps = []
    return { ...app.state }
  })
  await submit()
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
  expect(view!.get('[role="alert"]').text()).toBe("Sign-in cancelled")
  expect(app.onboarding.get).toHaveBeenCalledTimes(reads + 1)
  expect(app.onboarding.complete).not.toHaveBeenCalled()

  app.permissions.linuxDesktopBackend = "x11"
  app.changed()
  await flushPromises()
  expect(view!.get('[role="alert"]').text()).toBe("Sign-in cancelled")
})

test("Linux welcome retains Wayland retry guidance while its backend is unknown", async () => {
  const app = setup("accessibility", false, "linux")
  app.state.linuxDesktopBackend = undefined
  app.onboarding.permissions.mockRejectedValueOnce(new Error("Local Agent disconnected"))
  app.mount()
  await flushPromises()
  expect(view!.get("h1").text()).toBe("Mouse and keyboard control")
  app.state.linuxDesktopBackend = "wayland"
  app.permissions.linuxDesktopBackend = "wayland"
  app.changed()
  await flushPromises()
  expect(view!.get("h1").text()).toBe("Mouse and keyboard control")
  await click("Retry access")
  expect(app.onboarding.requestPermission).toHaveBeenCalledExactlyOnceWith("accessibility")
})

test("Linux welcome defers late backend reconciliation until an active permission request settles", async () => {
  const app = setup("screenCapture", false, "linux")
  app.state.linuxDesktopBackend = undefined
  let reject!: (reason: Error) => void
  app.onboarding.requestPermission.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  app.mount()
  await flushPromises()
  await click("Retry access")
  const reads = app.onboarding.get.mock.calls.length

  app.state.linuxDesktopBackend = "x11"
  app.state.permissionSteps = []
  app.state.step = "account"
  app.permissions.linuxDesktopBackend = "x11"
  app.changed()
  app.changed()
  await flushPromises()
  expect(app.onboarding.get).toHaveBeenCalledTimes(reads)
  reject(new Error("Welcome setup step has changed"))
  await flushPromises()
  expect(app.onboarding.get).toHaveBeenCalledTimes(reads + 1)
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
  expect(view!.find('[role="alert"]').exists()).toBe(false)
})

test("Linux welcome recovers when the host normalized its step before the permission read", async () => {
  const app = setup("screenCapture", false, "linux")
  app.state.linuxDesktopBackend = undefined
  app.onboarding.permissions.mockImplementationOnce(async () => {
    app.state.step = "account"
    app.state.linuxDesktopBackend = "x11"
    app.state.permissionSteps = []
    throw new Error("Welcome setup is not on a permission step")
  })
  app.mount()
  await flushPromises()
  expect(view!.get("h1").text()).toBe("Sign in to DeskFleet")
  expect(view!.find('[role="alert"]').exists()).toBe(false)
})
