import { createVaporApp, defineVaporComponent, nextTick, ref, withVaporDirectives, type App } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { vSpring, vSpringChildren, vSpringEnter, vSpringHover } from "./spring.ts"

// Node's default Vue entry omits Vapor. Exercise the same complete runtime
// exposed by Vue's browser build, including its directive scopes and scheduling.
vi.mock("vue", async () => {
  // @ts-expect-error The browser bundle shares Vue's public types without its own declaration file.
  return await import("vue/dist/vue.runtime-with-vapor.esm-browser.js")
})

let frames: Map<number, FrameRequestCallback>
let frameId = 0
let vaporApp: App | undefined
let vaporHost: HTMLElement | undefined
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["performance"] })
  frames = new Map()
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++frameId, callback); return frameId })
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id) })
})
afterEach(() => {
  vaporApp?.unmount()
  vaporApp = undefined
  vaporHost?.remove()
  vaporHost = undefined
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

test("Vapor directives track target getters, animate entrances and hover, and release their scopes", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const width = ref(96)
  const root = document.createElement("section")
  const label = document.createElement("span")
  const overlay = document.createElement("div")
  overlay.dataset.side = "bottom"
  const route = document.createElement("main")
  const header = document.createElement("header")
  const content = document.createElement("article")
  route.append(header, content)
  const button = document.createElement("button")
  root.append(label, overlay, route, button)
  vaporHost = document.createElement("div")
  document.body.append(vaporHost)
  vaporApp = createVaporApp(defineVaporComponent(() => {
    withVaporDirectives(label, [[vSpring, () => ({ width: `${width.value}px` })]])
    withVaporDirectives(overlay, [[vSpringEnter]])
    withVaporDirectives(route, [[vSpringChildren]])
    withVaporDirectives(button, [[vSpringHover, () => -2]])
    return root
  }))
  vaporApp.mount(vaporHost)
  await nextTick()
  expect(label.style.width).toBe("96px")
  expect(overlay.style.translate).toBe("0px -4px")
  expect(content.style.translate).toBe("0px 8px")
  expect(header.style.translate).toBe("")
  width.value = 160
  await nextTick()
  expect(label.style.width).toBe("96px")
  button.dispatchEvent(new PointerEvent("pointerenter"))
  await tick(64)
  expect(parseFloat(label.style.width)).toBeGreaterThan(96)
  expect(parseFloat(label.style.width)).toBeLessThan(160)
  expect(button.style.translate).not.toBe("0px 0px")
  vaporApp.unmount()
  vaporApp = undefined
  expect(frames.size).toBe(0)
  const lastWidth = label.style.width
  width.value = 240
  button.dispatchEvent(new PointerEvent("pointerenter"))
  const laterContent = document.createElement("article")
  route.append(laterContent)
  await nextTick()
  expect(label.style.width).toBe(lastWidth)
  expect(laterContent.style.translate).toBe("")
  expect(frames.size).toBe(0)
  expect(warn).not.toHaveBeenCalled()
})

