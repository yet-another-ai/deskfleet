import { client as platformClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"
import App from "./App.vue"
import { i18n } from "./i18n/index.ts"
import { router } from "./router/index.ts"
import { useLayoutStore } from "./stores/layout.ts"
import { catalogFixture } from "./test/catalog.ts"

let wrapper: VueWrapper | undefined
let pinia: ReturnType<typeof createPinia>
let setWidth: (width: number) => void

beforeAll(async () => {
  await Promise.all([import("./views/NewSessionView.vue"), import("./views/ArchivedSessionsView.vue")])
})
beforeEach(() => {
  window.localStorage.clear()
  pinia = createPinia()
  let width = 390
  const queries: (EventTarget & { matches: boolean; media: string })[] = []
  vi.spyOn(window, "matchMedia").mockImplementation(query => {
    const media = Object.assign(new EventTarget(), { matches: query.includes("max-width") && width < 1024, media: query })
    queries.push(media)
    return media as MediaQueryList
  })
  setWidth = value => {
    width = value
    for (const media of queries) {
      media.matches = media.media.includes("max-width") && width < 1024
      media.dispatchEvent(Object.assign(new Event("change"), { matches: media.matches }))
    }
  }
  vi.spyOn(platformClient.catalog, "list").mockResolvedValue(catalogFixture())
  vi.spyOn(platformClient.desktop, "target").mockResolvedValue({ id: "local-daemon", name: "test-host", online: true, desktop: true })
})
afterEach(async () => {
  wrapper?.unmount()
  wrapper = undefined
  disposePinia(pinia)
  await router.replace("/")
  vi.restoreAllMocks()
})

async function mountApp() {
  await router.push("/")
  wrapper = mount(App, {
    attachTo: document.body,
    global: { plugins: [pinia, router, i18n], stubs: { Teleport: { inheritAttrs: false, template: "<slot />" } } },
  })
  await flushPromises()
  return wrapper
}

test("compact drawers preserve desktop widths and visibility across viewport changes", async () => {
  window.localStorage.setItem("deskfleet.sidebar-open", "false")
  window.localStorage.setItem("deskfleet.details-open", "true")
  window.localStorage.setItem("deskfleet.sidebar-width", "420")
  window.localStorage.setItem("deskfleet.details-width", "380")
  const view = await mountApp()
  const layout = useLayoutStore(pinia)
  expect(view.find("aside").exists()).toBe(false)
  await view.get('main [aria-label="Show sidebar"]').trigger("click")
  expect(view.get<HTMLElement>('[role="dialog"] aside').element.style.width).toBe("100%")
  expect(view.find('[role="separator"]').exists()).toBe(false)
  layout.toggleDetails()
  await flushPromises()
  expect(view.findAll('[role="dialog"]')).toHaveLength(1)
  expect(view.get('[role="dialog"] aside').attributes("aria-label")).toBe("Changes")
  expect(view.find('[role="separator"]').exists()).toBe(false)
  await view.get('[role="dialog"] [aria-label="Hide changes panel"]').trigger("click")
  expect(view.find("aside").exists()).toBe(false)
  expect(window.localStorage.getItem("deskfleet.sidebar-open")).toBe("false")
  expect(window.localStorage.getItem("deskfleet.details-open")).toBe("true")
  expect(window.localStorage.getItem("deskfleet.sidebar-width")).toBe("420")
  expect(window.localStorage.getItem("deskfleet.details-width")).toBe("380")

  setWidth(1024)
  await flushPromises()
  expect(view.find('[role="dialog"]').exists()).toBe(false)
  expect(view.findAll("aside")).toHaveLength(1)
  expect(view.get<HTMLElement>('aside[aria-label="Changes"]').element.style.width).toBe("380px")
  layout.toggleSidebar()
  await flushPromises()
  expect(view.get<HTMLElement>("aside:not([aria-label])").element.style.width).toBe("420px")
  setWidth(768)
  await flushPromises()
  expect(view.find("aside").exists()).toBe(false)
  setWidth(1280)
  await flushPromises()
  expect(view.findAll("aside")).toHaveLength(2)
})

test("Escape closes a compact drawer and returns focus to its visible opener", async () => {
  const view = await mountApp()
  const opener = view.get<HTMLButtonElement>('main [aria-label="Show sidebar"]')
  opener.element.focus()
  await opener.trigger("click")
  await vi.waitFor(() => expect(view.get('[role="dialog"]').element.contains(document.activeElement)).toBe(true))
  await view.get('[role="dialog"]').trigger("keydown", { key: "Escape" })
  await vi.waitFor(() => expect(view.find('[role="dialog"]').exists()).toBe(false))
  await vi.waitFor(() => expect(document.activeElement).toBe(opener.element))
})

test("compact navigation closes on both a new destination and the current destination", async () => {
  const view = await mountApp()
  await view.get('main [aria-label="Show sidebar"]').trigger("click")
  await view.get('[role="dialog"] a[aria-label="Conversations"]').trigger("click")
  await flushPromises()
  expect(view.find('[role="dialog"]').exists()).toBe(false)
  await view.get('main [aria-label="Show sidebar"]').trigger("click")
  await view.get('[data-archived-sessions]').trigger("click")
  await flushPromises()
  expect(router.currentRoute.value.name).toBe("archived-sessions")
  expect(view.find('[role="dialog"]').exists()).toBe(false)
  expect(window.localStorage.getItem("deskfleet.sidebar-open")).toBe("true")
})

test("unmounting a machine surface clears its compact drawer before the runtime is reused", async () => {
  const view = await mountApp()
  await view.get('main [aria-label="Show sidebar"]').trigger("click")
  view.unmount()
  wrapper = undefined
  const remounted = await mountApp()
  expect(remounted.find('[role="dialog"]').exists()).toBe(false)
  expect(remounted.find("aside").exists()).toBe(false)
})
