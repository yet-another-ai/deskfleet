import { getClient } from "@deskfleet/client/platform"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { computed, defineComponent, h, ref } from "vue"
import { platformClientKey } from "../../composables/usePlatformClient.ts"
import { accountSessionKey } from "../../composables/account-session-context.ts"
import { i18n } from "../../i18n/index.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { catalogFixture, sessionId } from "../../test/catalog.ts"
import SessionWebPreviewPanel from "./SessionWebPreviewPanel.vue"

const mounted: Array<{ wrapper: VueWrapper; pinia: ReturnType<typeof createPinia> }> = []

afterEach(() => {
  for (const { wrapper, pinia } of mounted.splice(0)) {
    wrapper.unmount()
    disposePinia(pinia)
  }
})

interface SetupOptions {
  platform?: DeskfleetDesktopApi["platform"]
  local?: boolean
  online?: boolean
  active?: boolean
  initialUrl?: string | null
}

async function setup(options: SetupOptions = {}) {
  const pinia = createPinia()
  const local = options.local ?? true
  const online = options.online ?? true
  const machineId = local ? "9007199254740999" : "remote-machine-1"
  let forwardSeq = 0

  const startMock = vi.fn(async (input: Parameters<NonNullable<DeskfleetDesktopApi["ports"]>["start"]>[0]) => ({
    id: `fwd-${++forwardSeq}`,
    target: input.target,
    targetHost: input.targetHost ?? "127.0.0.1",
    targetPort: input.targetPort,
    localHost: "127.0.0.1" as const,
    localPort: 41233 + forwardSeq,
  }))
  const stopMock = vi.fn(async () => {})
  const openDevToolsMock = vi.fn(async () => {})

  const client: DeskfleetDesktopApi = {
    ...getClient(),
    platform: options.platform ?? "linux",
    target: { id: machineId, local },
    ports: {
      start: startMock,
      stop: stopMock,
      list: async () => [],
    },
    webPreview: { openDevTools: openDevToolsMock },
  }

  const provide: Record<PropertyKey, unknown> = { [platformClientKey as symbol]: client }
  if (!local) {
    provide[accountSessionKey as symbol] = {
      localMachineId: computed(() => "different-local-machine"),
      machines: ref([{ id: machineId, teamId: "1", name: "remote-box", online, desktop: true, local: false }]),
    }
  }

  let fleet!: ReturnType<typeof useFleetStore>
  const panelActive = ref(options.active ?? true)
  const Host = defineComponent({
    setup() {
      fleet = useFleetStore(pinia)
      fleet.catalog = { ...catalogFixture(), machineId }
      fleet.localDesktopTarget = { id: machineId, name: local ? "local-box" : "remote-box", online, desktop: true }
      return () => h(SessionWebPreviewPanel, { sessionId, active: panelActive.value, initialUrl: options.initialUrl ?? null })
    },
  })

  const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia, i18n], provide } })
  mounted.push({ wrapper, pinia })
  await flushPromises()
  return {
    wrapper,
    panel: () => wrapper.getComponent(SessionWebPreviewPanel),
    setActive(next: boolean) { panelActive.value = next },
    fleet,
    startMock,
    stopMock,
    openDevToolsMock,
  }
}

test("defers connection until first activation and stays connected while hidden", async () => {
  const { wrapper, setActive, startMock, stopMock } = await setup({
    local: false,
    online: true,
    active: false,
    initialUrl: "http://localhost:5173",
  })

  expect(startMock).not.toHaveBeenCalled()
  expect(wrapper.find("webview").exists()).toBe(false)

  setActive(true)
  await flushPromises()
  expect(startMock).toHaveBeenCalledTimes(1)
  expect(wrapper.find("webview").exists()).toBe(true)

  setActive(false)
  await flushPromises()
  expect(stopMock).not.toHaveBeenCalled()
})

test("desktop local connects directly in temp webview partition, syncs URL, and opens DevTools", async () => {
  const { wrapper, panel, startMock, openDevToolsMock } = await setup({
    local: true,
    online: true,
    initialUrl: "http://localhost:5173",
  })

  expect(startMock).not.toHaveBeenCalled()
  const webview = wrapper.get("[data-web-preview-webview-host] webview")
  expect(webview.attributes("partition")).toBe("temp:deskfleet-web-preview")
  expect(webview.attributes("src")).toBe("http://localhost:5173/")

  const devtoolsButton = () => wrapper.get("[data-web-preview-devtools]")
  expect(devtoolsButton().attributes("aria-disabled")).toBe("true")

  const goBack = vi.fn()
  Object.assign(webview.element, {
    canGoBack: () => true,
    canGoForward: () => false,
    goBack,
    getWebContentsId: () => 99,
  })
  webview.element.dispatchEvent(new Event("dom-ready"))
  await flushPromises()
  expect(devtoolsButton().attributes("aria-disabled")).toBeUndefined()
  expect(wrapper.get("[data-web-preview-back]").attributes("aria-disabled")).toBeUndefined()
  expect(wrapper.get("[data-web-preview-forward]").attributes("aria-disabled")).toBe("true")

  await devtoolsButton().trigger("click")
  expect(openDevToolsMock).toHaveBeenCalledWith(99)

  webview.element.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "http://localhost:5173/docs?view=1", isMainFrame: true }))
  webview.element.dispatchEvent(Object.assign(new Event("page-title-updated"), { title: "Docs" }))
  await flushPromises()

  expect((wrapper.get("[data-web-preview-address]").element as HTMLInputElement).value).toBe("http://localhost:5173/docs?view=1")
  expect(panel().emitted("change")?.at(-1)).toEqual(["http://localhost:5173/docs?view=1"])
  expect(panel().emitted("title")?.at(-1)).toEqual(["Docs"])

  webview.element.dispatchEvent(Object.assign(new Event("page-title-updated"), { title: "http://127.0.0.1:41234/" }))
  await flushPromises()
  expect(panel().emitted("title")?.at(-1)).toEqual(["localhost:5173"])

  await wrapper.get("[data-web-preview-back]").trigger("click")
  expect(goBack).toHaveBeenCalledTimes(1)
})

test("desktop remote tunnels via ports.start, hides random port from address bar, and cleans up on change or unmount", async () => {
  const { wrapper, panel, startMock, stopMock } = await setup({
    local: false,
    online: true,
    initialUrl: "http://localhost:5173",
  })

  expect(startMock).toHaveBeenCalledWith({
    target: { teamId: "1", machineId: "remote-machine-1" },
    targetHost: "localhost",
    targetPort: 5173,
  })

  const webview = wrapper.get("webview")
  expect(webview.attributes("src")).toBe("http://127.0.0.1:41234/")
  expect((wrapper.get("[data-web-preview-address]").element as HTMLInputElement).value).toBe("http://localhost:5173")

  webview.element.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "http://127.0.0.1:9999/other", isMainFrame: true }))
  webview.element.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "http://127.0.0.1:41234/docs", isMainFrame: false }))
  await flushPromises()
  expect((wrapper.get("[data-web-preview-address]").element as HTMLInputElement).value).toBe("http://localhost:5173")

  webview.element.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "http://127.0.0.1:41234/docs", isMainFrame: true }))
  await flushPromises()
  expect((wrapper.get("[data-web-preview-address]").element as HTMLInputElement).value).toBe("http://localhost:5173/docs")
  expect(panel().emitted("change")?.at(-1)).toEqual(["http://localhost:5173/docs"])

  await wrapper.get("[data-web-preview-address]").setValue("http://127.0.0.1:3000/api")
  await wrapper.get("form").trigger("submit")
  await flushPromises()

  expect(stopMock).toHaveBeenCalledWith("fwd-1")
  expect(startMock).toHaveBeenLastCalledWith({
    target: { teamId: "1", machineId: "remote-machine-1" },
    targetHost: "127.0.0.1",
    targetPort: 3000,
  })
  expect(wrapper.get("webview").attributes("src")).toBe("http://127.0.0.1:41235/api")

  wrapper.unmount()
  await flushPromises()
  expect(stopMock).toHaveBeenCalledWith("fwd-2")
})

test("rejects invalid addresses and reconnects once offline remote machine returns online", async () => {
  const { wrapper, fleet, startMock } = await setup({ local: false, online: false })

  for (const invalid of ["https://localhost:5173", "http://example.com:3000", "99999"]) {
    await wrapper.get("[data-web-preview-address]").setValue(invalid)
    await wrapper.get("form").trigger("submit")
    await flushPromises()
    expect(wrapper.find("[data-web-preview-address-error]").exists()).toBe(true)
  }
  expect(startMock).not.toHaveBeenCalled()

  await wrapper.get("[data-web-preview-quick-port='5173']").trigger("click")
  await flushPromises()
  expect(wrapper.find("[data-web-preview-offline]").exists()).toBe(true)
  expect(startMock).not.toHaveBeenCalled()

  fleet.localDesktopTarget = { ...fleet.localDesktopTarget, online: true }
  await flushPromises()
  expect(wrapper.find("[data-web-preview-offline]").exists()).toBe(false)
  expect(startMock).toHaveBeenCalledTimes(1)
  expect(wrapper.find("webview").exists()).toBe(true)
})
