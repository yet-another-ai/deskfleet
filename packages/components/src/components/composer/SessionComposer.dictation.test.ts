import { getClient } from "@deskfleet/client/platform"
import type { SpeechApi, SpeechEvent } from "@deskfleet/client/speech"
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { platformClientKey } from "../../composables/usePlatformClient.ts"
import { DICTATION_STORAGE_KEY } from "../../composables/useDictationPreference.ts"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import type { SessionTarget } from "../../stores/fleet.ts"
import PreferencesSettings from "../settings/PreferencesSettings.vue"
import SessionComposer from "./SessionComposer.vue"

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); localStorage.removeItem(DICTATION_STORAGE_KEY) })
const location: SessionTarget = {
  machine: { id: "local", name: "Host", local: true, online: true, desktop: true, workspaces: [], sessions: [], terminals: [] },
  session: { id: "session", title: "Voice", provider: "codex", archiveState: "active", context: "directory" },
}

async function fixture(supported = true) {
  let listener!: (event: SpeechEvent) => void
  const speech: SpeechApi = {
    status: vi.fn(async () => ({ supported })),
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
    onEvent: callback => { listener = callback; return () => {} },
  }
  const pinia = createPinia()
  const global = {
    plugins: [pinia, router, i18n],
    provide: { [platformClientKey as symbol]: { ...getClient(), platform: "web", speech } },
    stubs: { AgentConfigurationSelector: true },
  }
  const composer = mount(SessionComposer, { props: { location }, global })
  cleanups.push(() => { composer.unmount(); disposePinia(pinia) })
  await flushPromises()
  return { composer, speech, global, emit: (event: SpeechEvent) => listener(event) }
}

test("voice input defaults on, shows genuine levels, and the web preference cancels and hides it immediately", async () => {
  const f = await fixture()
  const settings = mount(PreferencesSettings, { global: f.global })
  cleanups.push(() => settings.unmount())
  const toggle = settings.get("[data-dictation-setting]")
  expect(toggle.attributes("aria-checked")).toBe("true")
  await f.composer.get("[data-composer-dictation]").trigger("click")
  const sessionId = vi.mocked(f.speech.start).mock.calls[0]![0].sessionId
  f.emit({ type: "started", sessionId })
  f.emit({ type: "level", level: 1, sessionId })
  f.emit({ type: "result", text: "Voice preview", final: false, sessionId })
  await flushPromises()
  expect(f.composer.get("[data-dictation-transcript]").text()).toBe("Voice preview")
  expect(f.composer.get("[data-dictation-waveform]").findAll("span").at(-1)!.attributes("style")).toContain("26px")
  expect(f.composer.emitted("update:modelValue")).toBeUndefined()
  await toggle.trigger("click")
  await flushPromises()
  expect(localStorage.getItem(DICTATION_STORAGE_KEY)).toBe("false")
  expect(f.composer.find("[data-composer-dictation]").exists()).toBe(false)
  expect(f.composer.find("[data-dictation-panel]").exists()).toBe(false)
  expect(f.speech.cancel).toHaveBeenCalledWith(sessionId)
})

test("unsupported devices hide the microphone while preserving the stored preference", async () => {
  const f = await fixture(false)
  expect(f.composer.find("[data-composer-dictation]").exists()).toBe(false)
  expect(f.speech.start).not.toHaveBeenCalled()
  expect(localStorage.getItem(DICTATION_STORAGE_KEY)).toBeNull()
})

test("a saved disabled preference survives remount and does not probe or start recognition", async () => {
  localStorage.setItem(DICTATION_STORAGE_KEY, "false")
  const f = await fixture()
  expect(f.composer.find("[data-composer-dictation]").exists()).toBe(false)
  expect(f.speech.status).not.toHaveBeenCalled()
  expect(f.speech.start).not.toHaveBeenCalled()
})
