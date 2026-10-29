import { configureClient, getClient } from "@deskfleet/client/platform"
import { DEFAULT_APPEARANCE_SETTINGS, type AppearanceSettings } from "@deskfleet/client/appearance"
import { createPinia, disposePinia, type Pinia } from "pinia"
import { nextTick } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { i18n } from "../i18n/index.ts"
import { APPEARANCE_STORAGE_KEY, useAppearanceStore } from "./appearance.ts"

const host = getClient()
let pinia: Pinia
beforeEach(() => {
  localStorage.clear()
  configureClient({ ...host, platform: "web", appearance: undefined })
  pinia = createPinia()
})
afterEach(() => {
  disposePinia(pinia)
  configureClient(host)
  localStorage.clear()
  document.documentElement.removeAttribute("style")
  document.documentElement.lang = "en-US"
  i18n.global.locale.value = "en-US"
  vi.restoreAllMocks()
})

test.each([
  ["zh-cmn-Hans-CN", "zh-Hans-CN"],
  ["ja-JP", "ja-JP"],
] as const)("restores browser preferences in %s before mounting and persists CSS fallback lists verbatim", async (language, documentLanguage) => {
  const saved: AppearanceSettings = {
    language, theme: "dark", interfaceFont: '"Noto Sans", sans-serif',
    terminalFont: '"Cascadia Code", "Noto Sans Mono CJK SC", monospace',
    terminalLigatures: true,
  }
  localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(saved))
  const appearance = useAppearanceStore(pinia)
  await appearance.initialize()
  expect(i18n.global.locale.value).toBe(language)
  expect(document.documentElement.lang).toBe(documentLanguage)
  expect(document.documentElement.style.colorScheme).toBe("dark")
  expect(document.documentElement.style.getPropertyValue("--ui-font-interface")).toBe(saved.interfaceFont)
  expect(appearance.terminalFont).toBe(saved.terminalFont)
  expect(appearance.terminalLigatures).toBe(true)
  await appearance.set({ theme: "light" })
  expect(document.documentElement.style.colorScheme).toBe("light")
  expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!)).toEqual({ ...saved, theme: "light" })
  disposePinia(pinia)
  pinia = createPinia()
  expect(useAppearanceStore(pinia).settings).toEqual({ ...saved, theme: "light" })
})

test("follows Japanese browser language preferences until a language is selected", async () => {
  const languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["ja-JP", "en-US"])
  const appearance = useAppearanceStore(pinia)
  await appearance.initialize()
  expect(i18n.global.locale.value).toBe("ja-JP")
  expect(document.documentElement.lang).toBe("ja-JP")
  await appearance.set({ language: "en-US" })
  expect(i18n.global.locale.value).toBe("en-US")
  await appearance.set({ language: "system" })
  expect(i18n.global.locale.value).toBe("ja-JP")
  languages.mockReturnValue(["en-US"])
  window.dispatchEvent(new Event("languagechange"))
  await nextTick()
  expect(i18n.global.locale.value).toBe("en-US")
})

test("explicit theme overrides OS changes and Follow System resumes tracking them", async () => {
  const media = new EventTarget() as MediaQueryList
  let dark = false
  Object.defineProperty(media, "matches", { get: () => dark })
  vi.spyOn(window, "matchMedia").mockReturnValue(media)
  const appearance = useAppearanceStore(pinia)
  await appearance.initialize()
  await nextTick()
  expect(appearance.isDark).toBe(false)
  dark = true
  media.dispatchEvent(Object.assign(new Event("change"), { matches: dark }))
  expect(appearance.isDark).toBe(true)
  await appearance.set({ theme: "light" })
  expect(appearance.isDark).toBe(false)
  await appearance.set({ theme: "system" })
  expect(appearance.isDark).toBe(true)
  expect(document.documentElement.style.colorScheme).toBe("light dark")
})

test("existing browser preferences retain their values when the ligatures setting is introduced", async () => {
  const saved = { language: "zh-cmn-Hans-CN", theme: "dark", interfaceFont: "Arial, sans-serif", terminalFont: '"Cascadia Code", monospace' }
  localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(saved))
  const appearance = useAppearanceStore(pinia)
  await appearance.initialize()
  expect(appearance.settings).toEqual({ ...saved, terminalLigatures: false })
  expect(appearance.terminalLigatures).toBe(false)
  await appearance.set({ terminalLigatures: true })
  expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!)).toEqual({ ...saved, terminalLigatures: true })
})

test("browser preferences synchronize with another tab", async () => {
  const appearance = useAppearanceStore(pinia)
  await appearance.initialize()
  await nextTick()
  const saved = { ...DEFAULT_APPEARANCE_SETTINGS, theme: "dark", interfaceFont: "serif" }
  window.dispatchEvent(new StorageEvent("storage", {
    key: APPEARANCE_STORAGE_KEY, newValue: JSON.stringify(saved), storageArea: localStorage,
  }))
  await nextTick()
  expect(appearance.settings).toEqual(saved)
  expect(document.documentElement.style.colorScheme).toBe("dark")
})

test("desktop preferences retain the host API across machine changes and recover after a failed save", async () => {
  let listener!: (settings: AppearanceSettings) => void
  const unsubscribe = vi.fn()
  const api = {
    get: vi.fn(async () => ({ ...DEFAULT_APPEARANCE_SETTINGS, language: "en-US" as const })),
    set: vi.fn(async (value: AppearanceSettings) => value),
    onChanged: vi.fn((callback: typeof listener) => { listener = callback; return unsubscribe }),
  }
  configureClient({ ...host, locale: "zh-cmn-Hans-CN", appearance: api })
  const appearance = useAppearanceStore(pinia)
  await appearance.initialize()
  configureClient({ ...host, appearance: undefined })
  await appearance.set({ language: "system" })
  expect(i18n.global.locale.value).toBe("zh-cmn-Hans-CN")
  expect(api.set).toHaveBeenCalledTimes(1)
  api.set.mockRejectedValueOnce(new Error("Disk full"))
  await appearance.set({ theme: "dark" })
  expect(appearance.error).toBe("Disk full")
  expect(appearance.settings.theme).toBe("system")
  await appearance.set({ theme: "dark" })
  expect(appearance.error).toBeNull()
  expect(appearance.settings.theme).toBe("dark")
  listener({ ...DEFAULT_APPEARANCE_SETTINGS, theme: "light" })
  expect(appearance.settings.theme).toBe("light")
  expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull()
  disposePinia(pinia)
  expect(unsubscribe).toHaveBeenCalledOnce()
})

test("a desktop read failure keeps startup usable and can be retried", async () => {
  const get = vi.fn().mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValue({ ...DEFAULT_APPEARANCE_SETTINGS, theme: "dark" })
  configureClient({ ...host, appearance: { get, set: vi.fn(), onChanged: () => () => {} } })
  const appearance = useAppearanceStore(pinia)
  await appearance.initialize()
  expect(appearance.ready).toBe(false)
  expect(appearance.error).toBe("Unavailable")
  await appearance.initialize()
  expect(appearance.ready).toBe(true)
  expect(appearance.error).toBeNull()
  expect(document.documentElement.style.colorScheme).toBe("dark")
})
