import { expect, test } from "vitest"
import { DEFAULT_APPEARANCE_SETTINGS, resolveActiveTerminalTheme, validateAppearanceSettings } from "./appearance.ts"
import { resolveTerminalTheme, TERMINAL_THEME_PRESETS, validateTerminalColors } from "./terminal-theme.ts"

test("saved color overrides resolve on top of the selected preset without mutating it", () => {
  const preset = TERMINAL_THEME_PRESETS.find(preset => preset.id === "dracula")!
  const overrides = { background: "#123456", brightRed: "#abcdef" }
  const colors = resolveTerminalTheme("dracula", overrides)
  expect(colors).toEqual({ ...preset.colors, ...overrides })
  colors.background = "#ffffff"
  expect(overrides.background).toBe("#123456")
  expect(resolveTerminalTheme("dracula").background).toBe("#282a36")
})

test("provides valid palettes for all presets including Catppuccin flavors", () => {
  expect(TERMINAL_THEME_PRESETS.map(preset => preset.id)).toEqual(expect.arrayContaining(["catppuccin-latte", "catppuccin-frappe", "catppuccin-macchiato", "catppuccin-mocha"]))
  for (const preset of TERMINAL_THEME_PRESETS) expect(validateTerminalColors(preset.colors)).toEqual(preset.colors)
})

test("existing appearance preferences gain the original terminal palette without losing their fonts", () => {
  const saved = { language: "system", theme: "light", interfaceFont: "Inter", terminalFont: "Menlo", terminalLigatures: true }
  expect(validateAppearanceSettings(saved)).toEqual({ ...DEFAULT_APPEARANCE_SETTINGS, ...saved })
  expect(resolveTerminalTheme("deskfleet")).toMatchObject({ background: "#15171d", foreground: "#e3e6ee", red: "#cc0000" })
})

test("appearance accepts known presets and normalizes committed light and dark hex colors", () => {
  const colors = { foreground: "#aAbBcC" }
  const lightColors = { background: "#DeF012" }
  const saved = validateAppearanceSettings({ ...DEFAULT_APPEARANCE_SETTINGS, terminalSeparateThemes: true, terminalTheme: "catppuccin-mocha", terminalColors: colors, terminalLightTheme: "catppuccin-latte", terminalLightColors: lightColors })
  expect(saved.terminalColors).toEqual({ foreground: "#aabbcc" })
  expect(saved.terminalColors).not.toBe(colors)
  expect(saved.terminalLightColors).toEqual({ background: "#def012" })
  expect(saved.terminalLightColors).not.toBe(lightColors)
})

test("resolves single or separate light/dark terminal themes from appearance settings", () => {
  const base = { ...DEFAULT_APPEARANCE_SETTINGS, terminalTheme: "catppuccin-mocha" as const, terminalColors: { cursor: "#112233" }, terminalLightTheme: "catppuccin-latte" as const, terminalLightColors: { background: "#f0f2f6" } }
  expect(resolveActiveTerminalTheme(base, false)).toEqual(resolveTerminalTheme("catppuccin-mocha", { cursor: "#112233" }))
  expect(resolveActiveTerminalTheme({ ...base, terminalSeparateThemes: true }, false)).toEqual(resolveTerminalTheme("catppuccin-latte", { background: "#f0f2f6" }))
  expect(resolveActiveTerminalTheme({ ...base, terminalSeparateThemes: true }, true)).toEqual(resolveTerminalTheme("catppuccin-mocha", { cursor: "#112233" }))
})

test.each([
  { terminalSeparateThemes: "yes" },
  { terminalTheme: "missing" },
  { terminalTheme: null },
  { terminalLightTheme: "missing" },
  { terminalColors: null },
  { terminalColors: [] },
  { terminalColors: { background: "red" } },
  { terminalColors: { background: "#12345" } },
  { terminalColors: { background: "#12345678" } },
  { terminalColors: { foreground: 42 } },
  { terminalColors: { unknown: "#123456" } },
  { terminalLightColors: null },
  { terminalLightColors: { background: "red" } },
])("rejects invalid terminal appearance %j", patch => {
  expect(() => validateAppearanceSettings({ ...DEFAULT_APPEARANCE_SETTINGS, ...patch })).toThrow()
})
