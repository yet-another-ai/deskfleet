import { mkdtempSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { DEFAULT_APPEARANCE_SETTINGS, type AppearanceSettings } from "../../../../packages/client/src/appearance.ts"
import { AppearanceSettingsController } from "./appearance-settings.ts"

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-appearance-"))
  directories.push(directory)
  const path = join(directory, "appearance.json")
  return { path, controller: new AppearanceSettingsController(path) }
}

test("appearance defaults follow the system and preserves CSS fallback stacks across restarts", () => {
  const { path, controller } = fixture()
  expect(controller.get()).toEqual(DEFAULT_APPEARANCE_SETTINGS)
  const selected: AppearanceSettings = {
    language: "zh-cmn-Hans-CN", theme: "dark", interfaceFont: '"Segoe UI", sans-serif',
    terminalFont: '"Cascadia Code", "Noto Sans Mono CJK SC", monospace',
    terminalLigatures: true,
  }
  expect(controller.set(selected)).toEqual(selected)
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(selected)
  expect(new AppearanceSettingsController(path).get()).toEqual(selected)
  selected.terminalFont = "changed"
  const copy = controller.get()
  copy.theme = "light"
  expect(controller.get()).toMatchObject({ theme: "dark", terminalFont: '"Cascadia Code", "Noto Sans Mono CJK SC", monospace' })
  controller.set({ ...DEFAULT_APPEARANCE_SETTINGS })
  expect(new AppearanceSettingsController(path).get()).toEqual(DEFAULT_APPEARANCE_SETTINGS)
})

test("failed persistence leaves the active appearance unchanged", () => {
  const { path, controller } = fixture()
  const previous = controller.get()
  mkdirSync(`${path}.tmp`)
  expect(() => controller.set({ ...previous, theme: "light" })).toThrow()
  expect(controller.get()).toEqual(previous)
})

test("existing desktop preferences keep their selected fonts and theme with ligatures disabled", () => {
  const { path, controller } = fixture()
  const saved = { language: "zh-cmn-Hans-CN", theme: "dark", interfaceFont: "Arial, sans-serif", terminalFont: '"Cascadia Code", monospace' }
  writeFileSync(path, JSON.stringify(saved))
  expect(controller.get()).toEqual({ ...saved, terminalLigatures: false })
})

test.each([
  ["malformed JSON", '{"theme":'],
  ["invalid schema", JSON.stringify({ ...DEFAULT_APPEARANCE_SETTINGS, theme: "sepia" })],
])("%s falls back to usable defaults without changing the saved file until the user saves", (_name, original) => {
  const { path, controller } = fixture()
  writeFileSync(path, original)
  expect(controller.get()).toEqual(DEFAULT_APPEARANCE_SETTINGS)
  expect(readFileSync(path, "utf8")).toBe(original)
  const selected: AppearanceSettings = { ...controller.get(), theme: "dark", terminalLigatures: true }
  expect(controller.set(selected)).toEqual(selected)
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(selected)
  expect(new AppearanceSettingsController(path).get()).toEqual(selected)
})

test("filesystem read failures remain actionable and can be retried after repair", () => {
  const { path, controller } = fixture()
  mkdirSync(path)
  expect(() => controller.get()).toThrow()
  rmdirSync(path)
  const saved = { ...DEFAULT_APPEARANCE_SETTINGS, theme: "dark" }
  writeFileSync(path, JSON.stringify(saved))
  expect(controller.get()).toEqual(saved)
})
