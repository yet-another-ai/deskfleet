import { expect, test } from "vitest"
import { DEFAULT_APPEARANCE_SETTINGS, validateAppearanceSettings } from "./appearance.ts"
import { resolveTerminalTheme, TERMINAL_THEME_PRESETS } from "./terminal-theme.ts"

test("saved color overrides resolve on top of the selected preset without mutating it", () => {
  const preset = TERMINAL_THEME_PRESETS.find(preset => preset.id === "dracula")!
  const overrides = { background: "#123456", brightRed: "#abcdef" }
  const colors = resolveTerminalTheme("dracula", overrides)
  expect(colors).toEqual({ ...preset.colors, ...overrides })
  colors.background = "#ffffff"
  expect(overrides.background).toBe("#123456")
  expect(resolveTerminalTheme("dracula").background).toBe("#282a36")
})

test("existing appearance preferences gain the original terminal palette without losing their fonts", () => {
  const saved = { language: "system", theme: "light", interfaceFont: "Inter", terminalFont: "Menlo", terminalLigatures: true }
  expect(validateAppearanceSettings(saved)).toEqual({ ...DEFAULT_APPEARANCE_SETTINGS, ...saved, terminalTheme: "deskfleet", terminalColors: {} })
  expect(resolveTerminalTheme("deskfleet")).toMatchObject({ background: "#15171d", foreground: "#e3e6ee", red: "#cc0000" })
})

test("appearance accepts a known preset and normalizes committed hex colors", () => {
  const colors = { foreground: "#aAbBcC" }
  const saved = validateAppearanceSettings({ ...DEFAULT_APPEARANCE_SETTINGS, terminalTheme: "solarized-light", terminalColors: colors })
  expect(saved.terminalColors).toEqual({ foreground: "#aabbcc" })
  expect(saved.terminalColors).not.toBe(colors)
})

test.each([
  { terminalTheme: "missing" },
  { terminalTheme: null },
  { terminalColors: null },
  { terminalColors: [] },
  { terminalColors: { background: "red" } },
  { terminalColors: { background: "#12345" } },
  { terminalColors: { background: "#12345678" } },
  { terminalColors: { foreground: 42 } },
  { terminalColors: { unknown: "#123456" } },
])("rejects invalid terminal appearance %j", patch => {
  expect(() => validateAppearanceSettings({ ...DEFAULT_APPEARANCE_SETTINGS, ...patch })).toThrow()
})
