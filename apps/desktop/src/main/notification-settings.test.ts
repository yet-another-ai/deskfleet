import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { NotificationSettingsController } from "./notification-settings.ts"

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-notifications-"))
  directories.push(directory)
  const path = join(directory, "notifications.json")
  return { path, controller: new NotificationSettingsController(path) }
}

test("notifications default on and category choices survive disabling and restarting", () => {
  const { path, controller } = fixture()
  expect(controller.get()).toEqual({ enabled: true, taskCompleted: true, taskNeedsInput: true })
  const selected = { enabled: false, taskCompleted: false, taskNeedsInput: true }
  expect(controller.set(selected)).toEqual(selected)
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(selected)
  const restarted = new NotificationSettingsController(path)
  expect(restarted.get()).toEqual(selected)
  expect(restarted.set({ ...restarted.get(), enabled: true })).toEqual({ ...selected, enabled: true })
  selected.enabled = true
  const copy = controller.get()
  copy.enabled = true
  expect(controller.get().enabled).toBe(false)
})

test("failed persistence leaves the active preferences unchanged", () => {
  const { path, controller } = fixture()
  const previous = controller.get()
  mkdirSync(`${path}.tmp`)
  expect(() => controller.set({ ...previous, enabled: false })).toThrow()
  expect(controller.get()).toEqual(previous)
})

test("invalid saved preferences are reported and can be reloaded after repair", () => {
  const { path, controller } = fixture()
  writeFileSync(path, JSON.stringify({ enabled: "false", taskCompleted: true, taskNeedsInput: true }))
  expect(() => controller.get()).toThrow("boolean preferences")
  writeFileSync(path, JSON.stringify({ enabled: false, taskCompleted: true, taskNeedsInput: false }))
  expect(controller.get()).toEqual({ enabled: false, taskCompleted: true, taskNeedsInput: false })
})
