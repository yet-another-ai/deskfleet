import { configureClient, getClient } from "@deskfleet/client/platform"
import { DEFAULT_APPEARANCE_SETTINGS, type AppearanceSettings } from "@deskfleet/client/appearance"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { nextTick } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { useAppearanceStore } from "../../stores/appearance.ts"
import AppearanceThemeColor from "./AppearanceThemeColor.vue"

const host = getClient()
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper
let frames: Map<number, FrameRequestCallback>
let frameId = 0
let saves: { value: AppearanceSettings; resolve: (value: AppearanceSettings) => void }[]
const set = vi.fn((value: AppearanceSettings) => new Promise<AppearanceSettings>(resolve => { saves.push({ value, resolve }) }))

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["performance"] })
  frames = new Map()
  saves = []
  set.mockClear()
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
    frames.set(++frameId, callback)
    return frameId
  })
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id) })
  configureClient({ ...host, appearance: {
    get: async () => ({ ...DEFAULT_APPEARANCE_SETTINGS, themeHue: 80 }),
    set, onChanged: () => () => {},
  } })
  pinia = createPinia()
  setActivePinia(pinia)
  await useAppearanceStore(pinia).initialize()
  wrapper = mount(AppearanceThemeColor, { global: { plugins: [pinia, i18n] } })
  const input = wrapper.get<HTMLInputElement>("[data-theme-hue-slider]").element
  vi.spyOn(input, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 24))
  input.setPointerCapture = vi.fn()
})
afterEach(() => {
  wrapper.unmount()
  disposePinia(pinia)
  configureClient(host)
  document.documentElement.removeAttribute("style")
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function tick(duration: number) {
  for (let elapsed = 0; elapsed < duration; elapsed += 16) {
    vi.advanceTimersByTime(16)
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(performance.now())
    await nextTick()
  }
}
async function change(value: number) {
  const input = wrapper.get<HTMLInputElement>("[data-theme-hue-slider]")
  input.element.value = String(value)
  await input.trigger("input")
  await input.trigger("change")
  await tick(2000)
}
async function pointer(type: string, x: number) {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: x })
  Object.defineProperty(event, "timeStamp", { value: performance.now() })
  wrapper.get("[data-theme-hue-slider]").element.dispatchEvent(event)
  await nextTick()
}
async function finishSave(index: number) {
  const save = saves[index]!
  save.resolve(save.value)
  await flushPromises()
}

test("an earlier save completing during a new drag keeps its preview and pointer ownership", async () => {
  const appearance = useAppearanceStore(pinia)
  await change(140)
  expect(set).toHaveBeenCalledOnce()
  await pointer("pointerdown", 140 / 360 * 200)
  await tick(32)
  await pointer("pointermove", 120)
  expect(appearance.themeHue).toBe(216)

  await finishSave(0)
  expect(appearance.settings.themeHue).toBe(140)
  expect(appearance.themeHue).toBe(216)
  await tick(16)
  await pointer("pointermove", 130)
  expect(appearance.themeHue).toBe(234)
  await pointer("pointerup", 130)
  await tick(2000)
  expect(set).toHaveBeenCalledTimes(2)
  expect(saves[1]!.value.themeHue).toBe(appearance.themeHue)
  await finishSave(1)
  expect(appearance.settings.themeHue).toBe(appearance.themeHue)
})

test("a new value that settles during an earlier save is persisted after that save", async () => {
  const appearance = useAppearanceStore(pinia)
  await change(140)
  await change(220)
  expect(set).toHaveBeenCalledOnce()
  expect(appearance.themeHue).toBe(220)

  await finishSave(0)
  expect(set).toHaveBeenCalledTimes(2)
  expect(saves[1]!.value.themeHue).toBe(220)
  expect(appearance.themeHue).toBe(220)
  await finishSave(1)
  expect(appearance.settings.themeHue).toBe(220)
  expect(appearance.themeHue).toBe(220)
})
