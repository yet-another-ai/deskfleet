import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { getClient } from "@deskfleet/client/platform"
import type { DesktopPermissionsState, LocalAgentState } from "@deskfleet/client/local-agent"
import type { OnboardingApi, OnboardingPermission, OnboardingState, OnboardingStep } from "@deskfleet/client/onboarding"
import { i18n } from "./i18n/index.ts"
import AccountShell from "./AccountShell.vue"
import { fakeCentral } from "./test/central.ts"

let view: VueWrapper | undefined
afterEach(() => { view?.unmount(); view = undefined; vi.restoreAllMocks() })

function setup(initialStep: OnboardingStep = "server", signedIn = false) {
  const fake = fakeCentral({ signedIn, teams: [] })
  const state: OnboardingState = { step: initialStep }
  const permissions: DesktopPermissionsState = {
    fullDiskAccessPermission: { status: "denied" },
    screenCapturePermission: { status: "denied" },
    accessibilityPermission: { status: "denied" },
  }
  const listeners = new Set<(state: LocalAgentState) => void>()
  const next = (step: OnboardingStep) => { state.step = step; return { ...state } }
  const onboarding = {
    get: vi.fn(async () => ({ ...state })),
    saveServer: vi.fn(async (url: string) => { await fake.central.setServer(url); return next("fullDiskAccess") }),
    permissions: vi.fn(async () => ({ ...permissions })),
    requestPermission: vi.fn(async (kind: OnboardingPermission) => {
      permissions[`${kind}Permission`] = { status: "requesting" }
      return { ...permissions }
    }),
    advancePermission: vi.fn(async (kind: OnboardingPermission) => next({ fullDiskAccess: "screenCapture", screenCapture: "accessibility", accessibility: "account" }[kind] as OnboardingStep)),
    complete: vi.fn(async () => next("complete")),
  } satisfies OnboardingApi
  const host = {
    ...getClient(), platform: "darwin" as const, central: fake.central, onboarding,
    settings: { ...getClient().settings, onChanged: (listener: (state: LocalAgentState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
  }
  return {
    fake, state, permissions, onboarding, listeners,
    mount() { view = mount(AccountShell, { props: { host }, global: { plugins: [i18n] }, attachTo: document.body }) },
    changed() { for (const listener of listeners) listener({ enabled: true, status: "running", ...permissions }) },
  }
}

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

test("welcome saves the server, guides each permission, and finishes only after successful sign-in", async () => {
  const app = setup()
  app.mount()
  await flushPromises()
  expect(view!.get("h1").text()).toBe("Connect your server")
  expect(app.onboarding.permissions).not.toHaveBeenCalled()
  expect(app.onboarding.requestPermission).not.toHaveBeenCalled()
  await view!.get('[name="server-url"]').setValue("https://team.example")
  app.onboarding.saveServer.mockRejectedValueOnce(new Error("Invalid backend address"))
  await submit()
  expect(view!.get('[role="alert"]').text()).toBe("Invalid backend address")
  expect(view!.get("h1").text()).toBe("Connect your server")
  await submit()
  expect(app.onboarding.saveServer).toHaveBeenLastCalledWith("https://team.example")
  expect(view!.get("h1").text()).toBe("Full Disk Access")
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
  expect(view!.get("h1").text()).toBe("Accessibility")
  await click("Skip for now")
  expect(app.onboarding.advancePermission.mock.calls).toEqual([["fullDiskAccess"], ["screenCapture"], ["accessibility"]])
  expect(view!.get("h1").text()).toBe("Sign in to deskfleet")
  app.fake.central.login.mockRejectedValueOnce(new Error("Sign-in cancelled"))
  await submit()
  expect(view!.get('[role="alert"]').text()).toBe("Sign-in cancelled")
  expect(app.onboarding.complete).not.toHaveBeenCalled()
  await submit()
  expect(app.fake.central.setServer).toHaveBeenLastCalledWith("https://team.example")
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
  expect(view!.get("h1").text()).toBe("Accessibility")
  await click("Skip for now")
  app.onboarding.complete.mockRejectedValueOnce(new Error("Cannot save setup"))
  await submit()
  expect(view!.get('[role="alert"]').text()).toBe("Cannot save setup")
  expect(view!.text()).not.toContain("Welcome, Ada")
  await submit()
  expect(app.fake.central.login).not.toHaveBeenCalled()
  expect(view!.text()).toContain("Welcome, Ada")
})

test("setup loading and failure never reveal the signed-in application, and retry resumes setup", async () => {
  const app = setup("fullDiskAccess", true)
  let reject!: (reason: Error) => void
  app.onboarding.get.mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise }))
  app.mount()
  await flushPromises()
  expect(view!.get('[role="status"]').text()).toBe("Loading deskfleet…")
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
  expect(view!.get("h1").text()).toBe("Sign in to deskfleet")
  expect(view!.text()).toContain("Welcome to deskfleet")
  expect(view!.text()).not.toContain("Full Disk Access")
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
  expect(view!.get("h1").text()).toBe("Sign in to deskfleet")
  expect(view!.text()).not.toContain("Welcome, Ada")
  resolve({ step: "complete" })
  await flushPromises()
  expect(view!.text()).toContain("Welcome, Ada")
})

test("new permission events win over an older request response, and an active OS prompt cannot be skipped", async () => {
  const app = setup("fullDiskAccess")
  let resolve!: (state: DesktopPermissionsState) => void
  app.onboarding.requestPermission.mockImplementationOnce(() => new Promise(resolvePromise => { resolve = resolvePromise }))
  app.mount()
  await flushPromises()
  await click("Enable access")
  app.permissions.fullDiskAccessPermission = { status: "requesting" }
  app.changed()
  await flushPromises()
  const skip = view!.findAll("button").find(button => button.text() === "Skip for now")!
  expect(skip.attributes("disabled")).toBeDefined()
  await skip.trigger("click")
  expect(app.onboarding.advancePermission).not.toHaveBeenCalled()
  const stale = { ...app.permissions }
  app.permissions.fullDiskAccessPermission = { status: "granted" }
  app.changed()
  resolve(stale)
  await flushPromises()
  expect(view!.get('[role="status"]').text()).toBe("Access enabled")
  await click("Continue")
  expect(view!.get("h1").text()).toBe("Screen recording")
})
