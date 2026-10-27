import { getClient } from "@deskfleet/client/platform"
import {
  DEFAULT_APPEARANCE_SETTINGS, DEFAULT_INTERFACE_FONT, DEFAULT_TERMINAL_FONT,
  validateAppearanceSettings, type AppearanceSettings,
} from "@deskfleet/client/appearance"
import { intlLocale, resolveAppLocale } from "@deskfleet/client/i18n"
import { usePreferredDark, usePreferredLanguages, useStorage } from "@vueuse/core"
import { defineStore, type Pinia } from "pinia"
import { computed, hasInjectionContext, inject, onScopeDispose, ref, watch, type InjectionKey } from "vue"
import { i18n } from "../i18n/index.ts"

export const APPEARANCE_STORAGE_KEY = "deskfleet.appearance"

const defineAppearanceStore = defineStore("appearance", () => {
  // Appearance belongs to the viewing client, even while its machine adapter changes.
  const host = getClient()
  const api = host.appearance
  const error = ref<string | null>(null)
  const reportError = (reason: unknown) => { error.value = reason instanceof Error ? reason.message : String(reason) }
  const settings = api
    ? ref<AppearanceSettings>({ ...DEFAULT_APPEARANCE_SETTINGS })
    : useStorage<AppearanceSettings>(APPEARANCE_STORAGE_KEY, { ...DEFAULT_APPEARANCE_SETTINGS }, undefined, {
      writeDefaults: false,
      flush: "sync",
      serializer: { read: raw => validateAppearanceSettings(JSON.parse(raw)), write: JSON.stringify },
      onError: reportError,
    })
  const ready = ref(!api)
  const saving = ref(false)
  const preferredDark = usePreferredDark()
  const languages = usePreferredLanguages()
  const isDark = computed(() => settings.value.theme === "system" ? preferredDark.value : settings.value.theme === "dark")
  const interfaceFont = computed(() => settings.value.interfaceFont.trim() || DEFAULT_INTERFACE_FONT)
  const terminalFont = computed(() => settings.value.terminalFont.trim() || DEFAULT_TERMINAL_FONT)
  const terminalLigatures = computed(() => settings.value.terminalLigatures)
  const locale = computed(() => settings.value.language === "system"
    ? (host.platform === "web" ? resolveAppLocale(languages.value) : host.locale)
    : settings.value.language)
  let loading: Promise<void> | undefined
  let stopApplying: (() => void) | undefined
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
      stopApplying = watch([() => settings.value.theme, interfaceFont, locale], () => {
        document.documentElement.style.colorScheme = settings.value.theme === "system" ? "light dark" : settings.value.theme
        document.documentElement.style.setProperty("--ui-font-interface", interfaceFont.value)
        document.documentElement.lang = intlLocale(locale.value)
        i18n.global.locale.value = locale.value
      }, { immediate: true, flush: "sync" })
    })()
    await loading
    loading = undefined
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

  onScopeDispose(() => { disposed = true; unsubscribe?.(); stopApplying?.() })
  return { settings, ready, saving, error, isDark, interfaceFont, terminalFont, terminalLigatures, initialize, set }
})

type AppearanceStore = ReturnType<typeof defineAppearanceStore>
export const appearanceStoreKey: InjectionKey<AppearanceStore> = Symbol("client-appearance")

/** Nested machine apps reuse the client-owned store rather than resetting preferences. */
export function useAppearanceStore(pinia?: Pinia): AppearanceStore {
  return (!pinia && hasInjectionContext() ? inject(appearanceStoreKey, undefined) : undefined)
    ?? defineAppearanceStore(pinia)
}
