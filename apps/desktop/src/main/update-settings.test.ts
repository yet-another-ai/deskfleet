import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import type { AutoDownloadUpdatesState } from "../../../../packages/client/src/settings.ts"
import { UpdateSettingsController } from "./update-settings.ts"

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-update-settings-"))
  directories.push(directory)
  const path = join(directory, "preferences", "updates.json")
  const onChange = vi.fn<(state: AutoDownloadUpdatesState) => void>()
  return { path, onChange, controller: new UpdateSettingsController(path, onChange) }
}

test("defaults on, notifies on load and change, and restores the saved preference", () => {
  const { path, onChange, controller } = fixture()
  expect(controller.get()).toEqual({ enabled: true, pauseOnMetered: true, installOnQuit: true, installSource: "desktop_installer" })
  expect(controller.get()).toEqual({ enabled: true, pauseOnMetered: true, installOnQuit: true, installSource: "desktop_installer" })
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ enabled: true, pauseOnMetered: true, installOnQuit: true, installSource: "desktop_installer" })
  expect(controller.setEnabled(false)).toEqual({ enabled: false, pauseOnMetered: true, installOnQuit: true, installSource: "desktop_installer" })
  expect(onChange).toHaveBeenLastCalledWith({ enabled: false, pauseOnMetered: true, installOnQuit: true, installSource: "desktop_installer" })
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ enabled: false, pauseOnMetered: true, installOnQuit: true })
  const restarted = new UpdateSettingsController(path, onChange, "package_manager")
  expect(restarted.get()).toEqual({ enabled: false, pauseOnMetered: true, installOnQuit: true, installSource: "package_manager" })
  expect(restarted.setEnabled(true)).toEqual({ enabled: true, pauseOnMetered: true, installOnQuit: true, installSource: "package_manager" })
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ enabled: true, pauseOnMetered: true, installOnQuit: true })
})

test("sub-preferences default on for an existing automatic-download preference", () => {
  const { path, onChange, controller } = fixture()
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, '{"enabled":false}')
  expect(controller.get()).toEqual({ enabled: false, pauseOnMetered: true, installOnQuit: true, installSource: "desktop_installer" })
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ enabled: false, pauseOnMetered: true, installOnQuit: true, installSource: "desktop_installer" })
})

test("metered pause and install-on-quit persist independently and survive toggling automatic downloads", () => {
  const { path, onChange, controller } = fixture()
  expect(controller.setPauseOnMetered(false)).toEqual({ enabled: true, pauseOnMetered: false, installOnQuit: true, installSource: "desktop_installer" })
  expect(onChange).toHaveBeenLastCalledWith({ enabled: true, pauseOnMetered: false, installOnQuit: true, installSource: "desktop_installer" })
  expect(controller.setInstallOnQuit(false)).toEqual({ enabled: true, pauseOnMetered: false, installOnQuit: false, installSource: "desktop_installer" })
  expect(controller.setEnabled(false)).toEqual({ enabled: false, pauseOnMetered: false, installOnQuit: false, installSource: "desktop_installer" })
  const restarted = new UpdateSettingsController(path)
  expect(restarted.get()).toEqual({ enabled: false, pauseOnMetered: false, installOnQuit: false, installSource: "desktop_installer" })
  expect(restarted.setEnabled(true)).toEqual({ enabled: true, pauseOnMetered: false, installOnQuit: false, installSource: "desktop_installer" })
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ enabled: true, pauseOnMetered: false, installOnQuit: false })
  expect(restarted.setPauseOnMetered(true)).toEqual({ enabled: true, pauseOnMetered: true, installOnQuit: false, installSource: "desktop_installer" })
  expect(restarted.setInstallOnQuit(true)).toEqual({ enabled: true, pauseOnMetered: true, installOnQuit: true, installSource: "desktop_installer" })
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ enabled: true, pauseOnMetered: true, installOnQuit: true })
})

test("failed persistence leaves active preferences unchanged", () => {
  const { path, onChange, controller } = fixture()
  expect(controller.get()).toEqual({ enabled: true, pauseOnMetered: true, installOnQuit: true, installSource: "desktop_installer" })
  onChange.mockClear()
  mkdirSync(`${path}.tmp`, { recursive: true })
  expect(() => controller.setEnabled(false)).toThrow()
  expect(() => controller.setPauseOnMetered(false)).toThrow()
  expect(() => controller.setInstallOnQuit(false)).toThrow()
  expect(controller.get()).toEqual({ enabled: true, pauseOnMetered: true, installOnQuit: true, installSource: "desktop_installer" })
  expect(onChange).not.toHaveBeenCalled()
})

test("invalid saved preferences are reported and can be reloaded after repair", () => {
  const { path, onChange, controller } = fixture()
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, '{"enabled":"false"}')
  expect(() => controller.get()).toThrow("Invalid automatic update settings")
  expect(onChange).not.toHaveBeenCalled()
  writeFileSync(path, '{"enabled":false}')
  expect(controller.get()).toEqual({ enabled: false, pauseOnMetered: true, installOnQuit: true, installSource: "desktop_installer" })
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ enabled: false, pauseOnMetered: true, installOnQuit: true, installSource: "desktop_installer" })
})

test.each(["false", null, 0, {}])("invalid saved sub-preference %j is reported before notifying the updater", invalid => {
  const { path, onChange, controller } = fixture()
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify({ enabled: false, pauseOnMetered: invalid }))
  expect(() => controller.get()).toThrow("Invalid automatic update settings")
  writeFileSync(path, JSON.stringify({ enabled: false, pauseOnMetered: false, installOnQuit: invalid }))
  expect(() => controller.get()).toThrow("Invalid automatic update settings")
  expect(onChange).not.toHaveBeenCalled()
  writeFileSync(path, JSON.stringify({ enabled: false, pauseOnMetered: false, installOnQuit: false }))
  expect(controller.get()).toEqual({ enabled: false, pauseOnMetered: false, installOnQuit: false, installSource: "desktop_installer" })
})
