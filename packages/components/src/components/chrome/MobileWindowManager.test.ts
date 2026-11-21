import { getClient } from "@deskfleet/client/platform"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { platformClientKey } from "../../composables/usePlatformClient.ts"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import { catalogFixture, sessionId, workspaceId } from "../../test/catalog.ts"
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
  window.localStorage.clear()
  await router.replace("/")
})

const webPreviewStub = {
  props: ["sessionId", "active", "initialUrl"],
  emits: ["title", "change"],
  template: '<div data-session-web-preview :data-session-id="sessionId" :data-active="String(active)" :data-url="initialUrl ?? \'\'"><button type="button" data-stub-commit @click="$emit(\'change\', \'http://localhost:5173/app\')" /></div>',
}

interface SetupOptions {
  platform?: DeskfleetDesktopApi["platform"]
  mobile?: boolean
  ports?: DeskfleetDesktopApi["ports"]
}

async function setup(options: SetupOptions = {}) {
  useFleetStore(pinia).catalog = catalogFixture()
  useTerminalsStore(pinia).loaded = true
  await router.replace(`/sessions/${sessionId}`)
  const baseClient = getClient()
  const platform = options.platform ?? "web"
  const mobile = options.mobile ?? true
  const ports = "ports" in options
    ? options.ports
    : {
        start: async () => ({
          id: "fwd-1",
          target: { teamId: "1", machineId: "1" },
          targetHost: "localhost" as const,
          targetPort: 5173,
          localHost: "127.0.0.1" as const,
          localPort: 41234,
        }),
        stop: async () => {},
        list: async () => [],
      }
  wrapper = mount(MobileWindowManager, {
    props: { sessionId }, attachTo: document.body,
    global: {
      plugins: [pinia, router, i18n],
      provide: { [platformClientKey as symbol]: { ...baseClient, platform, mobile, ports } },
      stubs: {
        SessionView: true, ChangesPanel: true, WindowToolbar: true,
        GithubPanel: { emits: ["insert"], template: '<button data-insert-github @click="$emit(\'insert\')">Insert</button>' },
        SessionDesktopPanel: { props: ["sessionId", "active"], template: '<div data-session-desktops :data-session-id="sessionId" :data-active="String(active)" />' },
        SessionWebPreviewPanel: webPreviewStub,
      },
    },
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

test("mobile overview adds a GitHub tab and returns to chat after inserting a reference", async () => {
  const view = await setup()
  useFleetStore(pinia).catalog!.workspaceGithubRepositories = [{ workspaceId, repositories: ["org/site"] }]
  await view.get("[data-open-overview]").trigger("click")
  await flushPromises()
  const add = view.findAll("button").find(button => button.text() === "Add GitHub tab")!
  await add.trigger("click")
  await flushPromises()
  expect(view.get('[data-mobile-view="github"]').attributes("aria-hidden")).toBe("false")
  await view.get("[data-insert-github]").trigger("click")
  await flushPromises()
  expect(view.get('[data-mobile-view="chat"]').attributes("aria-hidden")).toBe("false")
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

test("pure web omits mobile web preview creation even when persisted views exist", async () => {
  window.localStorage.setItem(
    `deskfleet.mobile-web-previews:${sessionId}`,
    JSON.stringify([{ id: "saved-1", url: "http://localhost:5173" }]),
  )
  const view = await setup({ platform: "web", mobile: false, ports: undefined })
  await view.get("[data-open-overview]").trigger("click")
  await flushPromises()

  expect(view.find("[data-new-web-preview]").exists()).toBe(false)
  expect(view.find('[data-mobile-view="web-preview:saved-1"]').exists()).toBe(false)
})

test("mobile overview creates, persists lazily, activates, and closes web previews", async () => {
  const first = await setup({ platform: "web", mobile: true })
  await first.get("[data-open-overview]").trigger("click")
  await flushPromises()

  await first.get("[data-new-web-preview]").trigger("click")
  await flushPromises()
  expect(first.get("[data-session-web-preview]").attributes("data-active")).toBe("true")

  await first.get("[data-stub-commit]").trigger("click")
  await flushPromises()

  const storedAfterCommit = JSON.parse(window.localStorage.getItem(`deskfleet.mobile-web-previews:${sessionId}`)!)
  expect(storedAfterCommit).toHaveLength(1)
  expect(storedAfterCommit[0].url).toBe("http://localhost:5173/app")
  const previewId = storedAfterCommit[0].id as string

  first.unmount()
  disposePinia(pinia)
  pinia = createPinia()

  const second = await setup({ platform: "web", mobile: true })
  expect(second.find("[data-session-web-preview]").exists()).toBe(false)

  await second.get("[data-open-overview]").trigger("click")
  await flushPromises()
  expect(second.find("[data-session-web-preview]").exists()).toBe(false)
  expect(second.find("[data-unopened-web-preview]").exists()).toBe(true)

  await second.get(`[data-mobile-view="web-preview:${previewId}"] button[aria-label="localhost:5173"]`).trigger("click")
  await flushPromises()
  expect(second.get("[data-session-web-preview]").attributes("data-active")).toBe("true")
  expect(second.get("[data-session-web-preview]").attributes("data-url")).toBe("http://localhost:5173/app")

  await second.get("[data-open-overview]").trigger("click")
  await flushPromises()
  await second.get(`[data-mobile-view="web-preview:${previewId}"] button[aria-label^="Close "]`).trigger("click")
  await flushPromises()

  expect(second.find(`[data-mobile-view="web-preview:${previewId}"]`).exists()).toBe(false)
  expect(JSON.parse(window.localStorage.getItem(`deskfleet.mobile-web-previews:${sessionId}`)!)).toEqual([])
})
