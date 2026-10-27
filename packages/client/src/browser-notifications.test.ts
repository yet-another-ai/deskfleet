import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { BrowserNotifications, getBrowserNotificationPermission, requestBrowserNotificationPermission } from "./browser-notifications.ts"
import type { NotificationSettings } from "./settings.ts"
import type { TaskNotification } from "./task-notification-monitor.ts"

const notifications: BrowserNotification[] = []
const construct = vi.fn()
const focus = vi.fn()
class BrowserNotification {
  static permission: NotificationPermission = "granted"
  static requestPermission = vi.fn<() => Promise<NotificationPermission>>()
  onclick: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((error: Event) => void) | null = null
  close = vi.fn()
  constructor(title: string, options: NotificationOptions) {
    construct(title, options)
    notifications.push(this)
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  notifications.length = 0
  BrowserNotification.permission = "granted"
  BrowserNotification.requestPermission.mockResolvedValue("granted")
  vi.stubGlobal("Notification", BrowserNotification)
  vi.stubGlobal("window", { isSecureContext: true, focus })
})
afterEach(() => vi.unstubAllGlobals())

function fixture() {
  const settings: NotificationSettings = { enabled: true, taskCompleted: true, taskNeedsInput: true }
  const getNotifications = vi.fn(async () => ({ ...settings }))
  const title = vi.fn((kind: TaskNotification["kind"]) => `translated:${kind}`)
  const onError = vi.fn()
  return { settings, getNotifications, title, onError, controller: new BrowserNotifications({ getNotifications }, title, onError) }
}

function event(kind: TaskNotification["kind"] = "taskCompleted"): TaskNotification {
  return { kind, machineId: "machine", sessionId: "session", title: "Update the browser client" }
}

function expectReleased(notification: BrowserNotification): void {
  expect(notification.onclick).toBeNull()
  expect(notification.onclose).toBeNull()
  expect(notification.onerror).toBeNull()
}

test("requests default permission immediately in the caller's user gesture", async () => {
  BrowserNotification.permission = "default"
  expect(getBrowserNotificationPermission()).toBe("default")
  const result = requestBrowserNotificationPermission()
  expect(BrowserNotification.requestPermission).toHaveBeenCalledOnce()
  expect(await result).toBe("granted")
})

test.each(["granted", "denied"] as const)("does not request permission again when %s", async permission => {
  BrowserNotification.permission = permission
  expect(getBrowserNotificationPermission()).toBe(permission)
  expect(await requestBrowserNotificationPermission()).toBe(permission)
  expect(BrowserNotification.requestPermission).not.toHaveBeenCalled()
})

test.each(["missing-window", "insecure", "missing-api"])("unsupported environments do not request or display notifications: %s", async kind => {
  if (kind === "missing-window") vi.stubGlobal("window", undefined)
  if (kind === "insecure") vi.stubGlobal("window", { isSecureContext: false, focus })
  if (kind === "missing-api") vi.stubGlobal("Notification", undefined)
  expect(getBrowserNotificationPermission()).toBe("unsupported")
  expect(await requestBrowserNotificationPermission()).toBe("unsupported")
  const f = fixture()
  await f.controller.notify(event())
  expect(f.getNotifications).not.toHaveBeenCalled()
  expect(construct).not.toHaveBeenCalled()
  expect(BrowserNotification.requestPermission).not.toHaveBeenCalled()
  expect(f.onError).not.toHaveBeenCalled()
})

test.each(["default", "denied"] as const)("notification delivery never prompts for %s permission", async permission => {
  BrowserNotification.permission = permission
  const f = fixture()
  await f.controller.notify(event())
  expect(construct).not.toHaveBeenCalled()
  expect(BrowserNotification.requestPermission).not.toHaveBeenCalled()
  expect(f.getNotifications).not.toHaveBeenCalled()
})

test("localizes each task category and keeps every displayed notification clickable", async () => {
  const f = fixture()
  for (const kind of ["taskCompleted", "taskNeedsInput"] as const) await f.controller.notify(event(kind))
  expect(construct.mock.calls).toEqual([
    ["translated:taskCompleted", { body: "Update the browser client" }],
    ["translated:taskNeedsInput", { body: "Update the browser client" }],
  ])
  for (const notification of notifications) {
    notification.onclick!()
    expect(notification.close).toHaveBeenCalledOnce()
    expectReleased(notification)
  }
  expect(focus).toHaveBeenCalledTimes(2)
  f.controller.close()
  for (const notification of notifications) expect(notification.close).toHaveBeenCalledOnce()
})

test("reads the latest master and category choices for each task event", async () => {
  const f = fixture()
  f.settings.enabled = false
  await f.controller.notify(event())
  await f.controller.notify(event("taskNeedsInput"))
  expect(construct).not.toHaveBeenCalled()
  f.settings.enabled = true
  f.settings.taskCompleted = false
  await f.controller.notify(event())
  await f.controller.notify(event("taskNeedsInput"))
  expect(construct).toHaveBeenCalledOnce()
  f.settings.taskCompleted = true
  f.settings.taskNeedsInput = false
  await f.controller.notify(event())
  await f.controller.notify(event("taskNeedsInput"))
  expect(construct).toHaveBeenCalledTimes(2)
  f.controller.close()
})

test("clear releases active instances and invalidates pending reads while allowing later notifications", async () => {
  const f = fixture()
  await f.controller.notify(event())
  await f.controller.notify(event("taskNeedsInput"))
  let resolve!: (settings: NotificationSettings) => void
  f.getNotifications.mockReturnValueOnce(new Promise(done => { resolve = done }))
  const pending = f.controller.notify(event())
  f.controller.clear()
  for (const notification of notifications) {
    expectReleased(notification)
    expect(notification.close).toHaveBeenCalledOnce()
  }
  resolve(f.settings)
  await pending
  expect(construct).toHaveBeenCalledTimes(2)
  await f.controller.notify(event())
  expect(construct).toHaveBeenCalledTimes(3)
  f.controller.close()
})

test("close invalidates pending delivery and permanently stops new notifications", async () => {
  const f = fixture()
  let resolve!: (settings: NotificationSettings) => void
  f.getNotifications.mockReturnValueOnce(new Promise(done => { resolve = done }))
  const pending = f.controller.notify(event())
  f.controller.close()
  resolve(f.settings)
  await pending
  await f.controller.notify(event())
  expect(f.getNotifications).toHaveBeenCalledOnce()
  expect(construct).not.toHaveBeenCalled()
})

test("permission revoked during a preference read prevents delivery", async () => {
  const f = fixture()
  f.getNotifications.mockImplementationOnce(async () => {
    BrowserNotification.permission = "denied"
    return f.settings
  })
  await f.controller.notify(event())
  expect(construct).not.toHaveBeenCalled()
})

test("close and error events release only the affected notification", async () => {
  const f = fixture()
  for (let index = 0; index < 3; index++) await f.controller.notify(event())
  const [dismissed, failed, active] = notifications
  dismissed!.onclose!()
  const error = new Event("error")
  failed!.onerror!(error)
  expect(f.onError).toHaveBeenCalledExactlyOnceWith(error)
  expectReleased(dismissed!)
  expectReleased(failed!)
  expect(active!.onclick).toBeTypeOf("function")
  f.controller.clear()
  expect(dismissed!.close).not.toHaveBeenCalled()
  expect(failed!.close).not.toHaveBeenCalled()
  expect(active!.close).toHaveBeenCalledOnce()
})

test.each(["preferences", "constructor"] as const)("%s failure does not reject task event processing", async stage => {
  const f = fixture()
  const error = new Error("Unavailable")
  if (stage === "preferences") f.getNotifications.mockRejectedValueOnce(error)
  else construct.mockImplementationOnce(() => { throw error })
  await expect(f.controller.notify(event())).resolves.toBeUndefined()
  expect(f.onError).toHaveBeenCalledExactlyOnceWith(error)
})

test("a failed dismissal does not prevent clearing the remaining notifications", async () => {
  const f = fixture()
  await f.controller.notify(event())
  await f.controller.notify(event())
  const error = new Error("Could not dismiss")
  notifications[0]!.close.mockImplementationOnce(() => { throw error })
  f.controller.close()
  for (const notification of notifications) {
    expectReleased(notification)
    expect(notification.close).toHaveBeenCalledOnce()
  }
  expect(f.onError).toHaveBeenCalledExactlyOnceWith(error)
})
