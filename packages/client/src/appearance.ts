import { isAppLocale, type AppLocale } from "./i18n.ts"

export const APPEARANCE_CHANNEL = "deskfleet:appearance"
export const APPEARANCE_CHANGED_EVENT = "deskfleet:appearance-changed"

export interface AppearanceSettings {
  language: "system" | AppLocale
  theme: "system" | "light" | "dark"
  /** Empty uses the application default; otherwise a CSS font-family list. */
  interfaceFont: string
  terminalFont: string
  terminalLigatures: boolean
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  language: "system", theme: "system", interfaceFont: "", terminalFont: "", terminalLigatures: false,
}

export const DEFAULT_INTERFACE_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
export const DEFAULT_TERMINAL_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

export interface AppearanceApi {
  get(): Promise<AppearanceSettings>
  set(value: AppearanceSettings): Promise<AppearanceSettings>
  onChanged(listener: (value: AppearanceSettings) => void): () => void
}

export function validateAppearanceSettings(value: unknown): AppearanceSettings {
  if (!value || typeof value !== "object"
    || !("language" in value) || (value.language !== "system" && !isAppLocale(value.language))
    || !("theme" in value) || (value.theme !== "system" && value.theme !== "light" && value.theme !== "dark")
    || !("interfaceFont" in value) || typeof value.interfaceFont !== "string"
    || !("terminalFont" in value) || typeof value.terminalFont !== "string"
    || ("terminalLigatures" in value && typeof value.terminalLigatures !== "boolean")) {
    throw new Error("Invalid appearance settings")
  }
  return {
    language: value.language, theme: value.theme, interfaceFont: value.interfaceFont, terminalFont: value.terminalFont,
    terminalLigatures: "terminalLigatures" in value && value.terminalLigatures === true,
  }
}
