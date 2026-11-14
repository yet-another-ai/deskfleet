import { mount, type VueWrapper } from "@vue/test-utils"
import { defineComponent, h, nextTick, ref, withDirectives } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { NavigationTransition } from "../services/navigation-motion.ts"
import { vNavigationMotion } from "./navigation-motion.ts"

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
function mountContent(initial: NavigationTransition) {
  const navigation = ref(initial)
  const loaded = ref(false)
  wrapper = mount(defineComponent({
    setup: () => () => withDirectives(h("article", loaded.value ? [h("p", "Loaded")] : []), [[vNavigationMotion, navigation.value]]),
  }))
  return { navigation, loaded, element: wrapper.element as HTMLElement }
}

test("peer navigation fades without moving and async content does not replay it", async () => {
  const { element, navigation, loaded } = mountContent({ key: "search", motion: "peer" })
  expect(element.style.translate).toBe("")
  await tick(2000)
  expect(element.style.opacity).toBe("")
  loaded.value = true
  navigation.value = { key: "search", motion: "none" }
  await nextTick()
  expect(element.style.cssText).toBe("")
  expect(frames.size).toBe(0)
})

test("a reused content boundary enters and returns without replacing its DOM", async () => {
  const { element, navigation } = mountContent({ key: "list", motion: "none" })
  navigation.value = { key: "detail", motion: "enter" }
  await nextTick()
  expect(wrapper!.element).toBe(element)
  expect(element.style.translate).toBe("16px 0px")
  await tick(80)
  navigation.value = { key: "list", motion: "return" }
  await nextTick()
  expect(element.style.translate).toBe("-16px 0px")
  expect(frames.size).toBe(1)
  await tick(2000)
  expect(element.style.cssText).toBe("")
  expect(frames.size).toBe(0)
})

test("reduced motion settles immediately when the preference changes mid-flight", async () => {
  const { element, navigation } = mountContent({ key: "detail", motion: "enter" })
  await tick(80)
  Object.defineProperty(media, "matches", { value: true })
  media.dispatchEvent(new Event("change"))
  expect(element.style.cssText).toBe("")
  expect(frames.size).toBe(0)
  navigation.value = { key: "list", motion: "return" }
  await nextTick()
  expect(element.style.cssText).toBe("")
  expect(frames.size).toBe(0)
})

test("unmount cancels frames and releases the preference listener", async () => {
  const remove = vi.spyOn(media, "removeEventListener")
  mountContent({ key: "detail", motion: "enter" })
  await tick(80)
  wrapper!.unmount()
  wrapper = undefined
  expect(frames.size).toBe(0)
  expect(remove).toHaveBeenCalledWith("change", expect.any(Function))
})
