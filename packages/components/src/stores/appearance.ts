import { getClient } from "@deskfleet/client/platform"
import {
  DEFAULT_APPEARANCE_SETTINGS, DEFAULT_INTERFACE_FONT, DEFAULT_TERMINAL_FONT, DEFAULT_THEME_HUE,
  validateAppearanceSettings, type AppearanceSettings,
} from "@deskfleet/client/appearance"
import { intlLocale, resolveAppLocale } from "@deskfleet/client/i18n"
import { resolveTerminalTheme } from "@deskfleet/client/terminal-theme"
import { chromaticColorFrom, fittedOklch, type Shade } from "@proj-airi/chromatic"
import { usePreferredDark, usePreferredLanguages, useRafFn, useStorage } from "@vueuse/core"
import { defineStore, type Pinia } from "pinia"
import { computed, hasInjectionContext, inject, onScopeDispose, ref, watch, type InjectionKey } from "vue"
import { i18n } from "../i18n/index.ts"

export const APPEARANCE_STORAGE_KEY = "deskfleet.appearance"

const THEME_HUE_PROPERTIES = [
  "--ui-color-accent",
  "--ui-color-action",
  "--ui-color-action-hover",
  "--ui-color-avatar",
  "--ui-color-focus",
  "--ui-color-accent-alt",
  "--ui-color-mini-accent-light",
  "--ui-color-mini-bubble-light",
  "--ui-color-mini-accent-dark",
  "--ui-color-mini-bubble-dark",
] as const

export function chromaticShadeCss(shade: Shade, hue: number, alpha?: number): string {
  const { l, c, h } = fittedOklch(shade, hue)
  const suffix = alpha === undefined ? "" : ` / ${alpha}`
  return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)}deg${suffix})`
}

export function chromaticShadeHex(shade: Shade, hue: number): string {
  return chromaticColorFrom(hue, { shade }).toHex()
}

function applyThemeHueTokens(style: CSSStyleDeclaration, hue: number | null): void {
  if (hue === null) {
    for (const name of THEME_HUE_PROPERTIES) style.removeProperty(name)
    return
  }
  const lightAccent = chromaticShadeCss(600, hue)
  const darkAccent = chromaticShadeCss(400, hue)
  const accent = `light-dark(${lightAccent}, ${darkAccent})`
  style.setProperty("--ui-color-accent", accent)
  style.setProperty("--ui-color-action", accent)
  style.setProperty("--ui-color-focus", accent)
  style.setProperty("--ui-color-action-hover", `light-dark(${chromaticShadeCss(700, hue)}, ${chromaticShadeCss(300, hue)})`)
  style.setProperty("--ui-color-avatar", `light-dark(${lightAccent}, ${chromaticShadeCss(500, hue)})`)
  style.setProperty("--ui-color-accent-alt", `light-dark(${chromaticShadeCss(600, hue + 40)}, ${chromaticShadeCss(400, hue + 40)})`)
  style.setProperty("--ui-color-mini-accent-light", chromaticShadeCss(500, hue))
  style.setProperty("--ui-color-mini-bubble-light", chromaticShadeCss(100, hue))
  style.setProperty("--ui-color-mini-accent-dark", darkAccent)
  style.setProperty("--ui-color-mini-bubble-dark", `color-mix(in srgb, ${darkAccent} 22%, #262a35)`)
}

const defineAppearanceStore = defineStore("appearance", () => {
  // Appearance belongs to the viewing client, even while its machine adapter changes.
  const host = getClient()
  const api = host.appearance
  const error = ref<string | null>(null)
  const reportError = (reason: unknown) => { error.value = reason instanceof Error ? reason.message : String(reason) }
  const settings = api
    ? ref<AppearanceSettings>(validateAppearanceSettings(DEFAULT_APPEARANCE_SETTINGS))
    : useStorage<AppearanceSettings>(APPEARANCE_STORAGE_KEY, validateAppearanceSettings(DEFAULT_APPEARANCE_SETTINGS), undefined, {
      writeDefaults: false,
      flush: "sync",
      serializer: { read: raw => validateAppearanceSettings(JSON.parse(raw)), write: JSON.stringify },
      onError: reportError,
    })
  const ready = ref(!api)
  const saving = ref(false)
  const previewHue = ref<number | null>(null)
  const dynamicHue = ref<number>(DEFAULT_THEME_HUE)
  const { pause: pauseDynamicHue, resume: resumeDynamicHue } = useRafFn(({ delta }) => {
    const dt = delta > 0 ? Math.min(64, delta) : 16.67
    dynamicHue.value = (dynamicHue.value + dt * 0.036) % 360
  }, { immediate: false })
  const preferredDark = usePreferredDark()
  const languages = usePreferredLanguages()
  const isDark = computed(() => settings.value.theme === "system" ? preferredDark.value : settings.value.theme === "dark")
  const activeThemeHue = computed<number | null>(() => settings.value.themeHueDynamic
    ? dynamicHue.value
    : (previewHue.value ?? settings.value.themeHue))
  const themeHue = computed<number>(() => activeThemeHue.value ?? DEFAULT_THEME_HUE)
  const interfaceFont = computed(() => settings.value.interfaceFont.trim() || DEFAULT_INTERFACE_FONT)
  const terminalFont = computed(() => settings.value.terminalFont.trim() || DEFAULT_TERMINAL_FONT)
  const terminalLigatures = computed(() => settings.value.terminalLigatures)
  const terminalTheme = computed(() => resolveTerminalTheme(settings.value.terminalTheme, settings.value.terminalColors))
  const locale = computed(() => settings.value.language === "system"
    ? (host.platform === "web" ? resolveAppLocale(languages.value) : host.locale)
    : settings.value.language)
  let loading: Promise<void> | undefined
  let stopApplying: (() => void) | undefined
  let stopDynamicWatch: (() => void) | undefined
  let disposed = false
  let revision = 0
  const unsubscribe = api?.onChanged(value => { revision++; settings.value = value })

  // Install document effects once at the client root, before any screen mounts.
  async function initialize(): Promise<void> {
    if (loading) return loading
    if (stopApplying && ready.value) return
    loading = (async () => {
      if (api && !ready.value) {
        const before = revision
        try {
          const value = await api.get()
          if (disposed) return
          if (revision === before) settings.value = value
          ready.value = true
          error.value = null
        } catch (reason) { if (!disposed) reportError(reason) }
      }
      if (disposed || stopApplying) return
      stopDynamicWatch = watch(() => settings.value.themeHueDynamic, enabled => {
        if (enabled) {
          dynamicHue.value = previewHue.value ?? settings.value.themeHue ?? DEFAULT_THEME_HUE
          resumeDynamicHue()
        } else {
          pauseDynamicHue()
        }
      }, { immediate: true, flush: "sync" })
      stopApplying = watch([() => settings.value.theme, activeThemeHue, interfaceFont, locale, terminalTheme], () => {
        document.documentElement.style.colorScheme = settings.value.theme === "system" ? "light dark" : settings.value.theme
        applyThemeHueTokens(document.documentElement.style, activeThemeHue.value)
        document.documentElement.style.setProperty("--ui-font-interface", interfaceFont.value)
        document.documentElement.style.setProperty("--ui-color-terminal", terminalTheme.value.background)
        document.documentElement.lang = intlLocale(locale.value)
        i18n.global.locale.value = locale.value
      }, { immediate: true, flush: "sync" })
    })()
    await loading
    loading = undefined
  }

  function previewThemeHue(hue: number | null): void {
    previewHue.value = hue === null || !Number.isFinite(hue) ? null : Math.min(360, Math.max(0, hue))
  }

  async function set(patch: Partial<AppearanceSettings>): Promise<void> {
    if (saving.value || !ready.value) return
    saving.value = true
    error.value = null
    try {
      const next = validateAppearanceSettings({ ...settings.value, ...patch })
      const saved = api ? await api.set(next) : next
      if (!disposed) settings.value = saved
    } catch (reason) { if (!disposed) reportError(reason) }
    finally { saving.value = false }
  }

  onScopeDispose(() => { disposed = true; unsubscribe?.(); stopDynamicWatch?.(); stopApplying?.(); pauseDynamicHue() })
  return {
    settings, ready, saving, error, isDark, activeThemeHue, themeHue,
    interfaceFont, terminalFont, terminalLigatures, terminalTheme,
    initialize, previewThemeHue, set,
  }
})

type AppearanceStore = ReturnType<typeof defineAppearanceStore>
export const appearanceStoreKey: InjectionKey<AppearanceStore> = Symbol("client-appearance")

/** Nested machine apps reuse the client-owned store rather than resetting preferences. */
export function useAppearanceStore(pinia?: Pinia): AppearanceStore {
  return (!pinia && hasInjectionContext() ? inject(appearanceStoreKey, undefined) : undefined)
    ?? defineAppearanceStore(pinia)
}
