import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { defineComponent } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { getClient } from "@deskfleet/client/platform"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import { i18n } from "../i18n/index.ts"
import { fakeCentral } from "../test/central.ts"
import { useBrowserNotifications } from "./useBrowserNotifications.ts"

const { deliveries, monitors, permission } = vi.hoisted(() => ({
  deliveries: [] as { clear: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> }[],
  monitors: [] as { start: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[],
  permission: vi.fn(() => "granted"),
}))
vi.mock("@deskfleet/client/browser-notifications", () => ({
  getBrowserNotificationPermission: permission,
  BrowserNotifications: class {
    clear = vi.fn()
    close = vi.fn()
    notify = vi.fn(async () => {})
    constructor() { deliveries.push(this) }
  },
}))
vi.mock("@deskfleet/client/task-notification-monitor", () => ({
  TaskNotificationMonitor: class {
    start = vi.fn(async () => {})
    close = vi.fn()
    constructor() { monitors.push(this) }
  },
}))

let view: VueWrapper | undefined
beforeEach(() => { deliveries.length = 0; monitors.length = 0; permission.mockReturnValue("granted") })
afterEach(() => { view?.unmount(); view = undefined })

function setup(platform: DeskfleetDesktopApi["platform"] = "web") {
  const fake = fakeCentral()
  const host = { ...getClient(), platform, central: fake.central }
  view = mount(defineComponent({
    setup() { useBrowserNotifications(host); return () => null },
  }), { global: { plugins: [i18n] } })
  return fake
}

test("web account ownership clears alerts on sign-out and restarts observation after a page-cache restore", async () => {
  const fake = setup()
  await flushPromises()
  expect(monitors[0]!.start).toHaveBeenCalledOnce()
  fake.emit({ type: "accountChanged" })
  expect(deliveries[0]!.clear).toHaveBeenCalledOnce()
  window.dispatchEvent(new Event("pagehide"))
  expect(monitors[0]!.close).toHaveBeenCalledOnce()
  expect(deliveries[0]!.close).toHaveBeenCalledOnce()
  fake.emit({ type: "accountChanged" })
  expect(deliveries[0]!.clear).toHaveBeenCalledOnce()
  window.dispatchEvent(new Event("pageshow"))
  window.dispatchEvent(new Event("pageshow"))
  expect(monitors).toHaveLength(2)
  expect(monitors[1]!.start).toHaveBeenCalledOnce()
  view!.unmount()
  view = undefined
  expect(monitors[1]!.close).toHaveBeenCalledOnce()
  expect(deliveries[1]!.close).toHaveBeenCalledOnce()
  window.dispatchEvent(new Event("pageshow"))
  expect(monitors).toHaveLength(2)
})

test("desktop hosts and unsupported browsers do not start another notification monitor", () => {
  setup("win32")
  expect(monitors).toHaveLength(0)
  view!.unmount()
  permission.mockReturnValue("unsupported")
  setup()
  expect(monitors).toHaveLength(0)
})
