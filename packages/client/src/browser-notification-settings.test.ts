import { expect, test, vi } from "vitest"
import { createBrowserNotificationSettings } from "./browser-notification-settings.ts"

function fixture() {
  const values = new Map<string, string>()
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
  }
  return { values, storage, settings: createBrowserNotificationSettings(storage) }
}

test("browser notification preferences default on and persist independent choices across instances", async () => {
  const { settings, storage } = fixture()
  expect(await settings.getNotifications()).toEqual({ enabled: true, taskCompleted: true, taskNeedsInput: true })
  const value = { enabled: false, taskCompleted: false, taskNeedsInput: true }
  expect(await settings.setNotifications(value)).toEqual(value)
  expect(await createBrowserNotificationSettings(storage).getNotifications()).toEqual(value)
  value.enabled = true
  expect(await settings.getNotifications()).toEqual({ ...value, enabled: false })
})

test("reads the latest preferences written by another page", async () => {
  const { settings, storage } = fixture()
  const otherPage = createBrowserNotificationSettings(storage)
  await settings.getNotifications()
  await otherPage.setNotifications({ enabled: true, taskCompleted: false, taskNeedsInput: false })
  expect(await settings.getNotifications()).toEqual({ enabled: true, taskCompleted: false, taskNeedsInput: false })
})

test("invalid stored preferences and failed writes are surfaced without replacing saved choices", async () => {
  const { settings, storage, values } = fixture()
  const previous = { enabled: false, taskCompleted: true, taskNeedsInput: false }
  await settings.setNotifications(previous)
  storage.setItem.mockImplementationOnce(() => { throw new Error("Storage unavailable") })
  await expect(settings.setNotifications({ ...previous, enabled: true })).rejects.toThrow("Storage unavailable")
  expect(await settings.getNotifications()).toEqual(previous)
  values.set("deskfleet.notifications", '{"enabled":true}')
  await expect(settings.getNotifications()).rejects.toThrow("boolean preferences")
})
