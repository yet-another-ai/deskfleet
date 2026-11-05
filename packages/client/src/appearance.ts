import { isAppLocale, type AppLocale } from "./i18n.ts"
import { isTerminalThemeId, validateTerminalColors, type TerminalColors, type TerminalThemeId } from "./terminal-theme.ts"

export const APPEARANCE_CHANNEL = "deskfleet:appearance"
export const APPEARANCE_CHANGED_EVENT = "deskfleet:appearance-changed"

/** Matches Nólëbase SpotlightStyle: Under = wash, Aside = left accent bar. */
export type ReadingSpotlightStyle = "under" | "aside"

export function isReadingSpotlightStyle(value: unknown): value is ReadingSpotlightStyle {
  return value === "under" || value === "aside"
}

export const DEFAULT_THEME_HUE = 272

export interface AppearanceSettings {
  language: "system" | AppLocale
  theme: "system" | "light" | "dark"
  /** Custom OKLCH hue in [0, 360], or null for the default DeskFleet palette. */
  themeHue: number | null
  /** Continuously cycle the theme hue across the spectrum. */
  themeHueDynamic: boolean
  /** Empty uses the application default; otherwise a CSS font-family list. */
  interfaceFont: string
  terminalFont: string
  terminalLigatures: boolean
  terminalTheme: TerminalThemeId
  /** Color overrides applied on top of the selected terminal preset. */
  terminalColors: Partial<TerminalColors>
  outlineAudio: boolean
  outlineAudioRgb: boolean
  outlineAudioMaxWidth: number
  outlineAudioDecayMs: number
  /** Highlight the hovered prose block/line while reading (Nólëbase-style box, no page dim). */
  readingSpotlight: boolean
  /** Spotlight visual style; defaults to Aside to match Nólëbase `defaultStyle`. */
  readingSpotlightStyle: ReadingSpotlightStyle
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  language: "system",
  theme: "system",
  themeHue: null,
  themeHueDynamic: false,
  interfaceFont: "",
  terminalFont: "",
  terminalLigatures: false,
  terminalTheme: "deskfleet",
  terminalColors: {},
  outlineAudio: false,
  outlineAudioRgb: false,
  outlineAudioMaxWidth: 32,
  outlineAudioDecayMs: 200,
  readingSpotlight: false,
  readingSpotlightStyle: "aside",
}

export const DEFAULT_INTERFACE_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
export const DEFAULT_TERMINAL_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

export interface AppearanceApi {
  get(): Promise<AppearanceSettings>
  set(value: AppearanceSettings): Promise<AppearanceSettings>
  onChanged(listener: (value: AppearanceSettings) => void): () => void
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isThemeHue(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 360)
}

export function validateAppearanceSettings(value: unknown): AppearanceSettings {
  if (!value || typeof value !== "object"
    || !("language" in value) || (value.language !== "system" && !isAppLocale(value.language))
    || !("theme" in value) || (value.theme !== "system" && value.theme !== "light" && value.theme !== "dark")
    || ("themeHue" in value && !isThemeHue(value.themeHue))
    || ("themeHueDynamic" in value && typeof value.themeHueDynamic !== "boolean")
    || !("interfaceFont" in value) || typeof value.interfaceFont !== "string"
    || !("terminalFont" in value) || typeof value.terminalFont !== "string"
    || ("terminalLigatures" in value && typeof value.terminalLigatures !== "boolean")
    || ("terminalTheme" in value && !isTerminalThemeId(value.terminalTheme))
    || ("outlineAudio" in value && typeof value.outlineAudio !== "boolean")
    || ("outlineAudioRgb" in value && typeof value.outlineAudioRgb !== "boolean")
    || ("outlineAudioMaxWidth" in value && !isNonNegativeNumber(value.outlineAudioMaxWidth))
    || ("outlineAudioDecayMs" in value && !isNonNegativeNumber(value.outlineAudioDecayMs))
    || ("readingSpotlight" in value && typeof value.readingSpotlight !== "boolean")
    || ("readingSpotlightStyle" in value && !isReadingSpotlightStyle(value.readingSpotlightStyle))) {
    throw new Error("Invalid appearance settings")
  }
  return {
    language: value.language,
    theme: value.theme,
    themeHue: "themeHue" in value && typeof value.themeHue === "number" ? value.themeHue : null,
    themeHueDynamic: "themeHueDynamic" in value && value.themeHueDynamic === true,
    interfaceFont: value.interfaceFont,
    terminalFont: value.terminalFont,
    terminalLigatures: "terminalLigatures" in value && value.terminalLigatures === true,
    terminalTheme: "terminalTheme" in value ? value.terminalTheme as TerminalThemeId : "deskfleet",
    terminalColors: "terminalColors" in value ? validateTerminalColors(value.terminalColors) : {},
    outlineAudio: "outlineAudio" in value && value.outlineAudio === true,
    outlineAudioRgb: "outlineAudioRgb" in value && value.outlineAudioRgb === true,
    outlineAudioMaxWidth: "outlineAudioMaxWidth" in value && typeof value.outlineAudioMaxWidth === "number"
      ? value.outlineAudioMaxWidth
      : DEFAULT_APPEARANCE_SETTINGS.outlineAudioMaxWidth,
    outlineAudioDecayMs: "outlineAudioDecayMs" in value && typeof value.outlineAudioDecayMs === "number"
      ? value.outlineAudioDecayMs
      : DEFAULT_APPEARANCE_SETTINGS.outlineAudioDecayMs,
    readingSpotlight: "readingSpotlight" in value && value.readingSpotlight === true,
    readingSpotlightStyle: "readingSpotlightStyle" in value && isReadingSpotlightStyle(value.readingSpotlightStyle)
      ? value.readingSpotlightStyle
      : DEFAULT_APPEARANCE_SETTINGS.readingSpotlightStyle,
  }
}
