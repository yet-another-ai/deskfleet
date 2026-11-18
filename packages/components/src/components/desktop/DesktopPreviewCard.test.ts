import type { DesktopMediaApi } from "@deskfleet/client/desktop-media"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, type Pinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { APPEARANCE_STORAGE_KEY, useAppearanceStore } from "../../stores/appearance.ts"
import { deferred, mockDesktopApi, stubWebRtc, TestPeer } from "../../test/desktop-media.ts"
import DesktopPreviewCard from "./DesktopPreviewCard.vue"

let wrapper: VueWrapper | undefined
let pinia: Pinia

beforeEach(() => {
  stubWebRtc()
  pinia = createPinia()
  localStorage.removeItem(APPEARANCE_STORAGE_KEY)
  i18n.global.locale.value = "en-US"
})
afterEach(async () => {
  wrapper?.unmount()
  wrapper = undefined
  disposePinia(pinia)
  await flushPromises()
  localStorage.removeItem(APPEARANCE_STORAGE_KEY)
  i18n.global.locale.value = "en-US"
  vi.unstubAllGlobals()
})

async function setup(openNative?: DesktopMediaApi["openNative"]) {
  const mock = mockDesktopApi()
  const api: DesktopMediaApi = { ...mock.api, ...(openNative ? { openNative } : {}) }
  wrapper = mount(DesktopPreviewCard, {
    props: {
      api, display: { id: 65539, width: 1920, height: 1080, refreshRateHz: 60, codecs: ["h264"] },
      displayIndex: 1, machineName: "Build host", active: false,
    },
    global: { plugins: [pinia, i18n] },
  })
  await flushPromises()
  return { ...mock, open: wrapper.get("button") }
}

test("native previews open the selected display directly with control, without a browser navigation", async () => {
  const openNative = vi.fn(async () => {})
  const current = await setup(openNative)
  await current.open.trigger("click")
  await flushPromises()
  expect(openNative).toHaveBeenCalledExactlyOnceWith({ displayId: 65539, control: true, locale: "en-US", theme: "light" })
  expect(wrapper!.emitted("open")).toBeUndefined()
  expect(current.api.offer).not.toHaveBeenCalled()
  expect(TestPeer.instances).toHaveLength(0)
})

test("native launch uses the current language and theme", async () => {
  const openNative = vi.fn(async () => {})
  const current = await setup(openNative)
  i18n.global.locale.value = "ja-JP"
  await useAppearanceStore(pinia).set({ theme: "dark" })
  await current.open.trigger("click")
  await flushPromises()
  expect(openNative).toHaveBeenCalledExactlyOnceWith({ displayId: 65539, control: true, locale: "ja-JP", theme: "dark" })
})

test("browser and PWA previews retain their open event for embedded viewing", async () => {
  const current = await setup()
  await current.open.trigger("click")
  expect(wrapper!.emitted("open")).toEqual([[]])
})

test("native launch disables the preview until opening finishes", async () => {
  const opening = deferred<void>()
  const openNative = vi.fn(() => opening.promise)
  const current = await setup(openNative)
  await current.open.trigger("click")
  expect(current.open.attributes("disabled")).toBeDefined()
  expect(wrapper!.text()).toContain("Opening native desktop window…")
  await current.open.trigger("click")
  expect(openNative).toHaveBeenCalledOnce()
  opening.resolve()
  await flushPromises()
  expect(current.open.attributes("disabled")).toBeUndefined()
  expect(wrapper!.emitted("open")).toBeUndefined()
})

test("native launch failures remain on the preview and retry from the notice", async () => {
  const openNative = vi.fn(async () => {}).mockRejectedValueOnce(new Error("Viewer executable is unavailable"))
  const current = await setup(openNative)
  await current.open.trigger("click")
  await flushPromises()
  const notice = wrapper!.get("[data-error-notice]")
  expect(notice.text()).toContain("Could not open the desktop window")
  expect(notice.text()).toContain("Viewer executable is unavailable")
  expect(current.open.attributes("disabled")).toBeUndefined()
  expect(wrapper!.emitted("open")).toBeUndefined()
  await notice.get("button").trigger("click")
  await flushPromises()
  expect(openNative).toHaveBeenCalledTimes(2)
  expect(wrapper!.find("[data-error-notice]").exists()).toBe(false)
})
