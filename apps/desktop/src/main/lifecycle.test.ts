import { EventEmitter } from "node:events"
import { expect, test, vi } from "vitest"
import { keepRunningInBackground } from "./lifecycle.ts"

class FakeApplication extends EventEmitter {
  quit = vi.fn(() => {
    const event = { defaultPrevented: false, preventDefault: () => (event.defaultPrevented = true) }
    this.emit("before-quit", event)
    return event.defaultPrevented
  })
}

test("ordinary quit requests hide the client instead of exiting", () => {
  const application = new FakeApplication()
  const hideWindows = vi.fn()
  const lifecycle = keepRunningInBackground(application, hideWindows)

  // Cmd+Q, the Dock menu, or a library calling app.quit().
  expect(application.quit()).toBe(true)
  expect(hideWindows).toHaveBeenCalledOnce()
  expect(lifecycle.quitting).toBe(false)
})

test("closing every window keeps the process alive", () => {
  const application = new FakeApplication()
  keepRunningInBackground(application, vi.fn())

  // Electron quits by default only when nothing listens for this event.
  expect(application.listenerCount("window-all-closed")).toBe(1)
})

test("the lifecycle quit path exits", () => {
  const application = new FakeApplication()
  const hideWindows = vi.fn()
  const lifecycle = keepRunningInBackground(application, hideWindows)

  lifecycle.quit()

  expect(lifecycle.quitting).toBe(true)
  expect(application.quit).toHaveReturnedWith(false)
  expect(hideWindows).not.toHaveBeenCalled()
})

test("the installer may close windows and quit after services stop", () => {
  const application = new FakeApplication()
  const hideWindows = vi.fn()
  const lifecycle = keepRunningInBackground(application, hideWindows)

  lifecycle.setInstallingUpdate(true)
  expect(lifecycle.quitting).toBe(true)
  expect(application.quit).not.toHaveBeenCalled()
  expect(application.quit()).toBe(false)
  expect(hideWindows).not.toHaveBeenCalled()
})

test("a failed install restores background behavior without cancelling an explicit exit", () => {
  const application = new FakeApplication()
  const hideWindows = vi.fn()
  const lifecycle = keepRunningInBackground(application, hideWindows)

  lifecycle.setInstallingUpdate(true)
  lifecycle.setInstallingUpdate(false)
  expect(lifecycle.quitting).toBe(false)
  expect(application.quit()).toBe(true)
  expect(hideWindows).toHaveBeenCalledOnce()

  lifecycle.setInstallingUpdate(true)
  lifecycle.quit()
  lifecycle.setInstallingUpdate(false)
  expect(lifecycle.quitting).toBe(true)
  expect(application.quit()).toBe(false)
})
