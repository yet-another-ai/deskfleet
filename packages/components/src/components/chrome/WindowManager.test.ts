import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { DockviewVue, type DockviewReadyEvent } from "dockview-vue"
import { afterEach, expect, test } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import { catalogFixture, sessionId } from "../../test/catalog.ts"
import WindowManager from "./WindowManager.vue"

const mounted: Array<{ wrapper: VueWrapper; pinia: ReturnType<typeof createPinia> }> = []
const desktopStub = { props: ["sessionId", "active"], template: '<div data-session-desktops :data-session-id="sessionId" :data-active="String(active)" />' }

afterEach(async () => {
  for (const { wrapper, pinia } of mounted.splice(0)) { wrapper.unmount(); disposePinia(pinia) }
  window.localStorage.clear()
  await router.replace("/")
})

async function setup() {
  const pinia = createPinia()
  useFleetStore(pinia).catalog = catalogFixture()
  useTerminalsStore(pinia).loaded = true
  await router.replace(`/sessions/${sessionId}`)
  const wrapper = mount(WindowManager, {
    props: { sessionId }, attachTo: document.body,
    global: { plugins: [pinia, router, i18n], stubs: {
      AppMainWindow: true, ChangesPanel: true, SessionPreviewWindow: true, WindowToolbar: true,
      SessionDesktopPanel: desktopStub,
    } },
  })
  mounted.push({ wrapper, pinia })
  await flushPromises()
  const { api } = wrapper.getComponent(DockviewVue).emitted("ready")![0]![0] as DockviewReadyEvent
  return { wrapper, api, pinia }
}

test("seeds an inactive desktop tab beside Changes and streams only while its tab is visible", async () => {
  const { wrapper, api } = await setup()
  const desktop = api.getPanel("desktops")!
  const changes = api.getPanel("changes")!
  const chat = api.getPanel("chat")!
  expect(desktop.api.group).toBe(changes.api.group)
  expect(desktop.api.group).not.toBe(chat.api.group)
  expect(changes.api.isVisible).toBe(true)
  expect(desktop.api.isVisible).toBe(false)
  expect(wrapper.find('[data-session-desktops][data-active="true"]').exists()).toBe(false)

  desktop.api.setActive()
  await flushPromises()
  expect(wrapper.get("[data-session-desktops]").attributes("data-session-id")).toBe(sessionId)
  expect(wrapper.get("[data-session-desktops]").attributes("data-active")).toBe("true")
  chat.api.setActive()
  await flushPromises()
  expect(wrapper.get("[data-session-desktops]").attributes("data-active")).toBe("true")
  changes.api.setActive()
  await flushPromises()
  expect(wrapper.find('[data-session-desktops][data-active="true"]').exists()).toBe(false)
  desktop.api.setActive()
  desktop.api.group.api.setVisible(false)
  await flushPromises()
  expect(wrapper.find('[data-session-desktops][data-active="true"]').exists()).toBe(false)
})

test("closing a desktop tab pauses it and + reopens it in the requested group", async () => {
  const { wrapper, api } = await setup()
  api.getPanel("desktops")!.api.setActive()
  await flushPromises()
  await wrapper.get('[aria-label="Close Desktops"]').trigger("click")
  await flushPromises()
  expect(api.getPanel("desktops")!.api.group.api.isVisible).toBe(false)
  expect(api.getPanel("changes")!.api.group.api.isVisible).toBe(true)
  expect(wrapper.find('[data-session-desktops][data-active="true"]').exists()).toBe(false)

  const changesGroup = wrapper.get('[data-window-tab-id="changes"]').element.closest(".dv-groupview")!
  ;(changesGroup.querySelector('[aria-label="Add window"]') as HTMLButtonElement).click()
  await flushPromises()
  const reopen = new DOMWrapper(document.body).get('[data-window-type="desktops"]')
  expect(reopen.attributes("data-disabled")).toBeUndefined()
  await reopen.trigger("click")
  await flushPromises()
  expect(api.getPanel("desktops")!.api.group).toBe(api.getPanel("changes")!.api.group)
  expect(wrapper.get("[data-session-desktops]").attributes("data-active")).toBe("true")
})

test("resource previews reuse the desktop group when Changes is closed and pause desktop capture", async () => {
  const { wrapper, api, pinia } = await setup()
  api.getPanel("desktops")!.api.setActive()
  await flushPromises()
  await wrapper.get('[aria-label="Close Changes"]').trigger("click")
  await flushPromises()
  const desktopGroup = api.getPanel("desktops")!.api.group
  expect(desktopGroup.api.isVisible).toBe(true)
  expect(useLayoutStore(pinia).requestSessionWindow({ kind: "preview", item: { kind: "image", title: "Screenshot", content: "https://example.test/screen.png", source: { sessionId } } })).toBe(true)
  await flushPromises()
  const preview = api.panels.find(panel => panel.id.startsWith("preview:"))!
  expect(preview.api.group).toBe(desktopGroup)
  expect(wrapper.find('[data-session-desktops][data-active="true"]').exists()).toBe(false)
})

test("a closed desktop tab stays closed when the Session layout is restored", async () => {
  const first = await setup()
  await first.wrapper.get('[aria-label="Close Desktops"]').trigger("click")
  await flushPromises()
  first.wrapper.unmount()
  disposePinia(first.pinia)
  mounted.splice(mounted.findIndex(value => value.wrapper === first.wrapper), 1)
  const second = await setup()
  expect(second.api.getPanel("desktops")!.api.group.api.isVisible).toBe(false)
  expect(second.wrapper.find('[data-session-desktops][data-active="true"]').exists()).toBe(false)
})

test("restoring a Chat-only layout never starts newly introduced desktop previews", async () => {
  const first = await setup()
  first.api.removePanel(first.api.getPanel("desktops")!)
  first.api.removePanel(first.api.getPanel("changes")!)
  await flushPromises()
  window.localStorage.setItem(`deskfleet.window-layout-v4:${sessionId}`, JSON.stringify(first.api.toJSON()))
  first.wrapper.unmount()
  disposePinia(first.pinia)
  mounted.splice(mounted.findIndex(value => value.wrapper === first.wrapper), 1)
  const second = await setup()
  expect(second.api.getPanel("desktops")!.api.group.api.isVisible).toBe(false)
  expect(second.wrapper.find('[data-session-desktops][data-active="true"]').exists()).toBe(false)
})
