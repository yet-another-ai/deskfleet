import type { Notification } from "electron"
import { beforeEach, expect, test, vi } from "vitest"
import type { NotificationSettings } from "../../../../packages/client/src/settings.ts"

const { isSupported, construct, show, close } = vi.hoisted(() => ({
  isSupported: vi.fn(), construct: vi.fn(), show: vi.fn(), close: vi.fn(),
}))
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events")
  return {
    Notification: class extends EventEmitter {
      static isSupported = isSupported
      constructor(options: unknown) {
        super()
        construct(this, options)
      }
      show(): void { show(this) }
      close(): void { close(this) }
    },
  }
})
vi.mock("./i18n.ts", () => ({ t: (key: string) => `translated:${key}` }))
import { DesktopNotifications } from "./notifications.ts"
import type { TaskNotification } from "@deskfleet/client/task-notification-monitor"

beforeEach(() => {
  vi.resetAllMocks()
  isSupported.mockReturnValue(true)
  vi.spyOn(console, "error").mockImplementation(() => {})
})

function fixture() {
  const settings: NotificationSettings = { enabled: true, taskCompleted: true, taskNeedsInput: true }
  const get = vi.fn(() => settings)
  const onClick = vi.fn()
  return { settings, get, onClick, controller: new DesktopNotifications({ get }, onClick) }
}

function event(kind: TaskNotification["kind"] = "taskCompleted"): TaskNotification {
  return { kind, machineId: "machine-1", sessionId: "session-1", title: "Update the desktop app" }
}

function lastNotification(): Notification {
  return construct.mock.calls.at(-1)![0] as Notification
}

test("shows translated task notifications and opens the app on click", () => {
  const { controller, onClick } = fixture()
  for (const kind of ["taskCompleted", "taskNeedsInput"] as const) {
    controller.notify(event(kind))
    const notification = lastNotification()
    expect(construct).toHaveBeenLastCalledWith(notification, {
      title: `translated:notification.${kind}`, body: "Update the desktop app",
    })
    expect(show).toHaveBeenLastCalledWith(notification)
    notification.emit("click", {})
    expect(notification.eventNames()).toEqual([])
  }
  expect(onClick).toHaveBeenCalledTimes(2)
  controller.close()
  expect(close).not.toHaveBeenCalled()
})

test("reads the current master and category preferences for each notification", () => {
  const { settings, controller } = fixture()
  settings.enabled = false
  controller.notify(event("taskCompleted"))
  controller.notify(event("taskNeedsInput"))
  expect(construct).not.toHaveBeenCalled()
  settings.enabled = true
  settings.taskCompleted = false
  controller.notify(event("taskCompleted"))
  controller.notify(event("taskNeedsInput"))
  expect(construct).toHaveBeenCalledOnce()
  settings.taskCompleted = true
  settings.taskNeedsInput = false
  controller.notify(event("taskCompleted"))
  controller.notify(event("taskNeedsInput"))
  expect(construct).toHaveBeenCalledTimes(2)
  controller.close()
})

test("skips notifications when the operating system does not support them", () => {
  const { controller } = fixture()
  isSupported.mockReturnValue(false)
  controller.notify(event())
  expect(construct).not.toHaveBeenCalled()
  expect(console.error).not.toHaveBeenCalled()
})

test("releases dismissed notifications and retains timed-out notifications until app exit", () => {
  const { controller, onClick } = fixture()
  controller.notify(event())
  const dismissed = lastNotification()
  dismissed.emit("close", { reason: "userCanceled" })
  expect(dismissed.eventNames()).toEqual([])
  controller.notify(event())
  const timedOut = lastNotification()
  timedOut.emit("close", { reason: "timedOut" })
  expect(timedOut.listenerCount("click")).toBe(1)
  controller.notify(event("taskNeedsInput"))
  const visible = lastNotification()
  controller.close()
  controller.close()
  expect(close.mock.calls).toEqual([[timedOut], [visible]])
  for (const notification of [timedOut, visible]) {
    expect(notification.eventNames()).toEqual([])
    notification.emit("click", {})
  }
  expect(onClick).not.toHaveBeenCalled()
  controller.notify(event())
  expect(construct).toHaveBeenCalledTimes(3)
})

test("a timed-out notification can still open the app from Action Center", () => {
  const { controller, onClick } = fixture()
  controller.notify(event())
  const notification = lastNotification()
  notification.emit("close", { reason: "timedOut" })
  notification.emit("click", {})
  expect(onClick).toHaveBeenCalledOnce()
  controller.close()
  expect(close).not.toHaveBeenCalled()
})

test("asynchronous OS failures are logged and release the notification", () => {
  const { controller } = fixture()
  controller.notify(event())
  const notification = lastNotification()
  notification.emit("failed", {}, "Notifications are unavailable")
  expect(console.error).toHaveBeenCalledExactlyOnceWith("Could not show desktop notification", "Notifications are unavailable")
  expect(notification.eventNames()).toEqual([])
  controller.close()
  expect(close).not.toHaveBeenCalled()
})

test.each(["settings", "support", "construct", "show"] as const)("%s failures do not interrupt session event processing", (stage) => {
  const { controller, get } = fixture()
  const error = new Error("Notifications are unavailable")
  const operation = { settings: get, support: isSupported, construct, show }[stage]!
  operation.mockImplementationOnce(() => { throw error })
  expect(() => controller.notify(event())).not.toThrow()
  expect(console.error).toHaveBeenCalledExactlyOnceWith("Could not show desktop notification", error)
  if (stage === "show") {
    expect(close).toHaveBeenCalledExactlyOnceWith(lastNotification())
    expect(lastNotification().eventNames()).toEqual([])
  }
  controller.close()
})

test("a failed dismissal still allows the remaining notifications to close", () => {
  const { controller } = fixture()
  controller.notify(event())
  const first = lastNotification()
  controller.notify(event())
  const second = lastNotification()
  const error = new Error("Could not dismiss notification")
  close.mockImplementationOnce(() => { throw error })
  expect(() => controller.close()).not.toThrow()
  expect(close.mock.calls).toEqual([[first], [second]])
  expect(first.eventNames()).toEqual([])
  expect(second.eventNames()).toEqual([])
  expect(console.error).toHaveBeenCalledExactlyOnceWith("Could not close desktop notification", error)
  controller.close()
  expect(close).toHaveBeenCalledTimes(2)
})

test("a failed app activation is logged without leaving active notification listeners", () => {
  const { controller, onClick } = fixture()
  const error = new Error("Could not open window")
  onClick.mockImplementationOnce(() => { throw error })
  controller.notify(event())
  const notification = lastNotification()
  expect(() => notification.emit("click", {})).not.toThrow()
  expect(notification.eventNames()).toEqual([])
  expect(console.error).toHaveBeenCalledExactlyOnceWith("Could not open desktop notification", error)
})
