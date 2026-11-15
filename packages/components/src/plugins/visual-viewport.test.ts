import { afterEach, expect, test } from "vitest"
import { createApp, h, nextTick, type App } from "vue"
import { visualViewportSizing } from "./visual-viewport.ts"

const apps = new Set<App>()
const originalViewport = Object.getOwnPropertyDescriptor(window, "visualViewport")
const originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight")
const style = document.documentElement.style
const height = () => style.getPropertyValue("--app-viewport-height")
const top = () => style.getPropertyValue("--app-viewport-top")

afterEach(() => {
  for (const app of apps) app.unmount()
  apps.clear()
  for (const [name, descriptor] of [["visualViewport", originalViewport], ["innerHeight", originalInnerHeight]] as const) {
    if (descriptor) Object.defineProperty(window, name, descriptor)
    else Reflect.deleteProperty(window, name)
  }
  style.removeProperty("--app-viewport-height")
  style.removeProperty("--app-viewport-top")
})

function viewport(initialHeight = 844) {
  const value = Object.assign(new EventTarget(), { height: initialHeight, scale: 1, offsetTop: 0 })
  Object.defineProperty(window, "visualViewport", { configurable: true, value })
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 })
  return value
}

async function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const app = createApp({ render: () => h("main") }).use(visualViewportSizing)
  apps.add(app)
  app.mount(host)
  await nextTick()
  return app
}

test("reserves the visible height as the keyboard opens and closes without a window resize", async () => {
  const screen = viewport()
  await mount()
  expect(height()).toBe("844px")
  expect(top()).toBe("0px")

  screen.height = 420
  screen.dispatchEvent(new Event("resize"))
  expect(window.innerHeight).toBe(844)
  expect(height()).toBe("420px")

  screen.height = 844
  screen.dispatchEvent(new Event("resize"))
  expect(window.innerHeight).toBe(844)
  expect(height()).toBe("844px")
})

test("uses the visible viewport immediately when mounting with the keyboard already open", async () => {
  viewport(420)
  await mount()
  expect(height()).toBe("420px")
  expect(top()).toBe("0px")
})

test("follows focus panning and resets the offset when the viewport returns", async () => {
  const screen = viewport(420)
  await mount()

  screen.offsetTop = 76
  screen.dispatchEvent(new Event("scroll"))
  expect(height()).toBe("420px")
  expect(top()).toBe("76px")

  screen.offsetTop = 0
  screen.dispatchEvent(new Event("scroll"))
  expect(top()).toBe("0px")
})

test("pinch zoom and zoom panning do not shrink or reposition the application", async () => {
  const screen = viewport()
  await mount()

  Object.assign(screen, { height: 422, scale: 2, offsetTop: 100 })
  screen.dispatchEvent(new Event("resize"))
  expect(height()).toBe("844px")
  expect(top()).toBe("0px")

  screen.offsetTop = 150
  screen.dispatchEvent(new Event("scroll"))
  expect(height()).toBe("844px")
  expect(top()).toBe("0px")
})

test("unmount removes sizing and stops viewport events from restoring it", async () => {
  const screen = viewport(420)
  const app = await mount()
  apps.delete(app)
  app.unmount()
  expect(height()).toBe("")
  expect(top()).toBe("")

  Object.assign(screen, { height: 844, offsetTop: 76 })
  screen.dispatchEvent(new Event("resize"))
  screen.dispatchEvent(new Event("scroll"))
  expect(height()).toBe("")
  expect(top()).toBe("")
})

test("leaves CSS viewport sizing available when the VisualViewport API is absent", async () => {
  Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined })
  await mount()
  window.dispatchEvent(new Event("resize"))
  expect(height()).toBe("")
  expect(top()).toBe("")
})
