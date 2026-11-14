import { mount, type VueWrapper } from "@vue/test-utils"
import { defineComponent, nextTick, ref } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import FocusOverlay from "./FocusOverlay.vue"

let wrapper: VueWrapper | undefined
let frames: Map<number, FrameRequestCallback>
let frameId = 0
let media: MediaQueryList
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["performance"] })
  frames = new Map()
  media = Object.assign(new EventTarget(), { matches: false, media: "(prefers-reduced-motion: reduce)" }) as MediaQueryList
  vi.spyOn(window, "matchMedia").mockReturnValue(media)
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++frameId, callback); return frameId })
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id) })
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); vi.useRealTimers() })
async function tick(duration: number) {
  for (let elapsed = 0; elapsed < duration; elapsed += 16) {
    vi.advanceTimersByTime(16)
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(performance.now())
    await nextTick()
  }
}
interface Preview { title: string; source: { entryId: string } }
const first: Preview = { title: "Preview", source: { entryId: "message-1" } }
function fixture(initial?: Preview) {
  const content = ref(initial)
  const closed = vi.fn(() => expect(document.querySelector("[data-focus-overlay]")).toBeNull())
  wrapper = mount(defineComponent({
    components: { FocusOverlay },
    setup: () => ({ content, closed }),
    template: '<FocusOverlay :content="content" data-focus-overlay class="surface" @after-leave="closed" v-slot="{ content: shown }"><span :data-source="shown.source.entryId">{{ shown.title }}</span></FocusOverlay>',
  }), { attachTo: document.body })
  return { content, closed, surface: () => wrapper!.get<HTMLElement>("[data-focus-overlay]") }
}

test("preview opening fades in and closing retains its descriptor until the surface leaves", async () => {
  const { content, closed, surface } = fixture()
  expect(wrapper!.find("[data-focus-overlay]").exists()).toBe(false)
  content.value = first
  await nextTick()
  expect(surface().element.style.opacity).toBe("0")
  await tick(96)
  expect(Number(surface().element.style.opacity)).toBeGreaterThan(0)
  expect(Number(surface().element.style.opacity)).toBeLessThan(1)
  await tick(2000)
  expect(surface().element.style.opacity).toBe("1")
  content.value = undefined
  await nextTick()
  expect(surface().text()).toBe("Preview")
  expect(surface().get("span").attributes("data-source")).toBe("message-1")
  expect(surface().attributes("inert")).toBeDefined()
  expect(closed).not.toHaveBeenCalled()
  await tick(96)
  expect(Number(surface().element.style.opacity)).toBeGreaterThan(0)
  expect(Number(surface().element.style.opacity)).toBeLessThan(1)
  await tick(2000)
  expect(wrapper!.find("[data-focus-overlay]").exists()).toBe(false)
  expect(closed).toHaveBeenCalledOnce()
})

test("reopening reverses the same surface without a jump or a premature leave callback", async () => {
  const { content, closed, surface } = fixture(first)
  await tick(2000)
  const element = surface().element
  const child = surface().get("span").element
  content.value = undefined
  await nextTick()
  await tick(96)
  const closingOpacity = element.style.opacity
  content.value = first
  await nextTick()
  expect(surface().element).toBe(element)
  expect(surface().get("span").element).toBe(child)
  expect(element.style.opacity).toBe(closingOpacity)
  await tick(2000)
  expect(element.style.opacity).toBe("1")
  expect(closed).not.toHaveBeenCalled()
})

test("changing an open descriptor keeps the surface visible and retains the latest source on close", async () => {
  const { content, surface } = fixture(first)
  await tick(2000)
  const element = surface().element
  content.value = { title: "Another preview", source: { entryId: "message-2" } }
  await nextTick()
  expect(surface().element).toBe(element)
  expect(element.style.opacity).toBe("1")
  content.value = undefined
  await nextTick()
  expect(surface().text()).toBe("Another preview")
  expect(surface().get("span").attributes("data-source")).toBe("message-2")
  await tick(2000)
})

test("reduced motion settles an in-flight exit and emits leave after removing the surface", async () => {
  const { content, closed } = fixture(first)
  await tick(2000)
  content.value = undefined
  await nextTick()
  await tick(64)
  Object.defineProperty(media, "matches", { value: true })
  media.dispatchEvent(Object.assign(new Event("change"), { matches: true }))
  await nextTick()
  await nextTick()
  expect(wrapper!.find("[data-focus-overlay]").exists()).toBe(false)
  expect(closed).toHaveBeenCalledOnce()
  expect(frames.size).toBe(0)
})

test("parent route teardown reports the removed preview and cancels its frame loop", async () => {
  const { closed } = fixture(first)
  await tick(64)
  wrapper!.unmount()
  wrapper = undefined
  expect(closed).toHaveBeenCalledOnce()
  expect(frames.size).toBe(0)
})
