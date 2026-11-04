import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import { catalogFixture, sessionId } from "../../test/catalog.ts"
import MobileWindowManager from "./MobileWindowManager.vue"

let wrapper: VueWrapper | undefined
let pinia: ReturnType<typeof createPinia>
beforeEach(() => {
  pinia = createPinia()
  vi.spyOn(window, "matchMedia").mockImplementation(query => Object.assign(new EventTarget(), { matches: query.includes("max-width") || query.includes("prefers-reduced-motion"), media: query }) as MediaQueryList)
})
afterEach(async () => {
  wrapper?.unmount(); wrapper = undefined
  disposePinia(pinia)
  await router.replace("/")
})

async function setup() {
  useFleetStore(pinia).catalog = catalogFixture()
  useTerminalsStore(pinia).loaded = true
  await router.replace(`/sessions/${sessionId}`)
  wrapper = mount(MobileWindowManager, {
    props: { sessionId }, attachTo: document.body,
    global: { plugins: [pinia, router, i18n], stubs: {
      SessionView: true, ChangesPanel: true, WindowToolbar: true,
      SessionDesktopPanel: { props: ["sessionId", "active"], template: '<div data-session-desktops :data-session-id="sessionId" :data-active="String(active)" />' },
    } },
  })
  await flushPromises()
  return wrapper
}

test("mobile overview does not mount desktop previews until explicitly selected", async () => {
  const view = await setup()
  expect(view.find("[data-session-desktops]").exists()).toBe(false)
  await view.get("[data-open-overview]").trigger("click")
  await flushPromises()
  expect(view.find("[data-session-desktops]").exists()).toBe(false)
  expect(view.find("[data-unopened-desktops]").exists()).toBe(true)
  await view.get('[data-view-overview] [aria-label="Desktops"]').trigger("click")
  await flushPromises()
  expect(view.get("[data-session-desktops]").attributes("data-session-id")).toBe(sessionId)
  expect(view.get("[data-session-desktops]").attributes("data-active")).toBe("true")
})

test("mobile previews pause in overview, behind the sidebar and when another view is selected", async () => {
  const view = await setup()
  await view.get("[data-open-overview]").trigger("click")
  await view.get('[data-view-overview] [aria-label="Desktops"]').trigger("click")
  await flushPromises()
  const panel = () => view.get("[data-session-desktops]")
  expect(panel().attributes("data-active")).toBe("true")
  const layout = useLayoutStore(pinia)
  layout.sidebarOpen = true
  await flushPromises()
  expect(panel().attributes("data-active")).toBe("false")
  layout.closeCompactPanel()
  await flushPromises()
  expect(panel().attributes("data-active")).toBe("true")
  await view.get("[data-open-overview]").trigger("click")
  await flushPromises()
  expect(panel().attributes("data-active")).toBe("false")
  await view.get('[data-view-overview] [aria-label="Changes"]').trigger("click")
  await flushPromises()
  expect(panel().attributes("data-active")).toBe("false")
  expect(view.get('[data-mobile-view="changes"]').attributes("aria-hidden")).toBe("false")
})
