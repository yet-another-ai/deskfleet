import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { UpdateSettingsController } from "./update-settings.ts"

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-update-settings-"))
  directories.push(directory)
  const path = join(directory, "preferences", "updates.json")
  const onChange = vi.fn<(enabled: boolean) => void>()
  return { path, onChange, controller: new UpdateSettingsController(path, onChange) }
}

test("defaults on, notifies on load and change, and restores the saved preference", () => {
  const { path, onChange, controller } = fixture()
  expect(controller.get()).toEqual({ enabled: true, installSource: "desktop_installer" })
  expect(controller.get()).toEqual({ enabled: true, installSource: "desktop_installer" })
  expect(onChange).toHaveBeenCalledExactlyOnceWith(true)
  expect(controller.setEnabled(false)).toEqual({ enabled: false, installSource: "desktop_installer" })
  expect(onChange).toHaveBeenLastCalledWith(false)
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ enabled: false })
  const restarted = new UpdateSettingsController(path, onChange, "package_manager")
  expect(restarted.get()).toEqual({ enabled: false, installSource: "package_manager" })
  expect(restarted.setEnabled(true)).toEqual({ enabled: true, installSource: "package_manager" })
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ enabled: true })
})

test("failed persistence leaves the active preference unchanged", () => {
  const { path, onChange, controller } = fixture()
  expect(controller.get()).toEqual({ enabled: true, installSource: "desktop_installer" })
  onChange.mockClear()
  mkdirSync(`${path}.tmp`, { recursive: true })
  expect(() => controller.setEnabled(false)).toThrow()
  expect(controller.get()).toEqual({ enabled: true, installSource: "desktop_installer" })
  expect(onChange).not.toHaveBeenCalled()
})

test("invalid saved preferences are reported and can be reloaded after repair", () => {
  const { path, onChange, controller } = fixture()
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, '{"enabled":"false"}')
  expect(() => controller.get()).toThrow("Invalid automatic update settings")
  expect(onChange).not.toHaveBeenCalled()
  writeFileSync(path, '{"enabled":false}')
  expect(controller.get()).toEqual({ enabled: false, installSource: "desktop_installer" })
  expect(onChange).toHaveBeenCalledExactlyOnceWith(false)
})
