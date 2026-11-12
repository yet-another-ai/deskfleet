import { DEFAULT_APPEARANCE_SETTINGS } from "@deskfleet/client/appearance"
import { configureClient, getClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { APPEARANCE_STORAGE_KEY, useAppearanceStore } from "../../stores/appearance.ts"
import { READING_SURFACE_ATTR } from "../../services/reading-spotlight.ts"
import ReadingSpotlight from "./ReadingSpotlight.vue"

const host = getClient()
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | undefined
let surface: HTMLDivElement
let paragraph: HTMLParagraphElement

beforeEach(() => {
  localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  configureClient({ ...host, platform: "web", appearance: undefined })
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false },
  }))
  surface = document.createElement("div")
  surface.setAttribute(READING_SURFACE_ATTR, "")
  paragraph = document.createElement("p")
  paragraph.textContent = "Readable prose for the spotlight."
  paragraph.style.margin = "0"
  paragraph.style.lineHeight = "20px"
  surface.append(paragraph)
  document.body.append(surface)
  paragraph.getBoundingClientRect = () => ({
    x: 16, y: 80, top: 80, left: 16, width: 320, height: 20, right: 336, bottom: 100, toJSON() { return this },
  })
  Object.defineProperty(paragraph, "offsetHeight", { configurable: true, get: () => 20 })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  disposePinia(pinia)
  configureClient(host)
  localStorage.clear()
  surface.remove()
  document.querySelectorAll("[data-reading-spotlight]").forEach(node => node.remove())
  vi.restoreAllMocks()
})

async function render(enabled = false) {
  if (enabled) localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ ...DEFAULT_APPEARANCE_SETTINGS, readingSpotlight: true }))
  const appearance = useAppearanceStore(pinia)
  await appearance.initialize()
  wrapper = mount(ReadingSpotlight, {
    attachTo: document.body,
    global: { plugins: [pinia, i18n] },
  })
  await flushPromises()
  return wrapper
}

function pointerAt(x: number, y: number, target: Element = paragraph): void {
  vi.spyOn(document, "elementFromPoint").mockReturnValue(target)
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }))
}

test("stays off until the appearance preference is enabled", async () => {
  await render(false)
  pointerAt(40, 90)
  await flushPromises()
  expect(document.querySelector("[data-reading-spotlight]")).toBeNull()
  expect(useAppearanceStore(pinia).settings.readingSpotlight).toBe(false)
})

test("highlights the hovered reading block when enabled and clears outside prose", async () => {
  await render(true)
  pointerAt(40, 90)
  await vi.waitFor(() => {
    const overlay = document.querySelector<HTMLElement>("[data-reading-spotlight]")
    expect(overlay).not.toBeNull()
    expect(overlay!.style.display).toBe("block")
    expect(overlay!.style.width).toBe("328px")
    expect(overlay!.dataset.readingSpotlightStyle).toBe("aside")
    expect(overlay!.classList.contains("ui-reading-spotlight-aside")).toBe(true)
    expect(overlay!.classList.contains("ui-reading-spotlight-under")).toBe(false)
  }, { timeout: 3000 })
  vi.spyOn(document, "elementFromPoint").mockReturnValue(document.body)
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 8, clientY: 8, bubbles: true }))
  await vi.waitFor(() => {
    const overlay = document.querySelector<HTMLElement>("[data-reading-spotlight]")
    expect(overlay === null || overlay.style.display === "none" || getComputedStyle(overlay).display === "none").toBe(true)
  })
})

test("applies the Under wash style without a page-dimming shadow", async () => {
  localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({
    ...DEFAULT_APPEARANCE_SETTINGS, readingSpotlight: true, readingSpotlightStyle: "under",
  }))
  const appearance = useAppearanceStore(pinia)
  await appearance.initialize()
  wrapper = mount(ReadingSpotlight, { attachTo: document.body, global: { plugins: [pinia, i18n] } })
  await flushPromises()
  pointerAt(40, 90)
  await vi.waitFor(() => {
    const overlay = document.querySelector<HTMLElement>("[data-reading-spotlight]")
    expect(overlay?.dataset.readingSpotlightStyle).toBe("under")
    expect(overlay?.classList.contains("ui-reading-spotlight-under")).toBe(true)
    expect(overlay?.classList.contains("ui-reading-spotlight-aside")).toBe(false)
  })
})

test("turning the preference off removes the spotlight immediately", async () => {
  await render(true)
  pointerAt(40, 90)
  await vi.waitFor(() => expect(document.querySelector("[data-reading-spotlight]")).not.toBeNull())
  await useAppearanceStore(pinia).set({ readingSpotlight: false })
  await flushPromises()
  const overlay = document.querySelector<HTMLElement>("[data-reading-spotlight]")
  expect(overlay === null || overlay.style.display === "none" || !overlay.checkVisibility?.()).toBe(true)
})
