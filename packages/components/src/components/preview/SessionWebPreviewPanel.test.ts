import { getClient } from "@deskfleet/client/platform"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import type { PortForward } from "@deskfleet/client/ports"
import type { WebPreviewDesktopApi } from "@deskfleet/client/web-preview"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { computed, defineComponent, h, ref } from "vue"
import { platformClientKey } from "../../composables/usePlatformClient.ts"
import { accountSessionKey } from "../../composables/account-session-context.ts"
import { i18n } from "../../i18n/index.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { catalogFixture, sessionId } from "../../test/catalog.ts"
import type { WebPreviewTarget } from "../../services/web-preview.ts"
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
  mobile?: boolean
  local?: boolean
  online?: boolean
  active?: boolean
  initialTarget?: WebPreviewTarget | null
  withWebPreview?: boolean
  ports?: DeskfleetDesktopApi["ports"]
  webPreview?: WebPreviewDesktopApi
  openExternal?: (url: string) => Promise<void>
}

async function setup(options: SetupOptions = {}) {
  const pinia = createPinia()
  const local = options.local ?? true
  const online = options.online ?? true
  const machineId = local ? "9007199254740999" : "remote-machine-1"
  let forwardSeq = 0
  let grantSeq = 0

  const startMock = vi.fn(async (_input: unknown) => ({
    id: `fwd-${++forwardSeq}`,
    localPort: 41233 + forwardSeq,
  }))
  const activeForwards = new Map<string, PortForward>()
  const retireForward = (id: string) => activeForwards.delete(id)
  const stopMock = vi.fn(async (id?: string) => {
    if (id) activeForwards.delete(id)
  })
  const portsMock: NonNullable<DeskfleetDesktopApi["ports"]> = options.ports ?? {
    start: async input => {
      const created = await startMock(input)
      const forward: PortForward = {
        id: created.id,
        target: input.target,
        targetHost: input.targetHost ?? "127.0.0.1",
        targetPort: input.targetPort,
        localHost: "127.0.0.1",
        localPort: created.localPort,
      }
      activeForwards.set(forward.id, forward)
      return forward
    },
    stop: stopMock,
    list: async () => [...activeForwards.values()],
  }

  const allowOriginMock = vi.fn(async () => `grant-${++grantSeq}`)
  const revokeOriginMock = vi.fn(async () => {})
  const openDevToolsMock = vi.fn(async () => {})
  const webPreviewMock: WebPreviewDesktopApi | undefined = options.withWebPreview === false
    ? undefined
    : (options.webPreview ?? {
        allowOrigin: allowOriginMock,
        revokeOrigin: revokeOriginMock,
        openDevTools: openDevToolsMock,
      })

  const openExternalMock = vi.fn(options.openExternal ?? (async () => {}))

  const baseClient = getClient()
  const client: DeskfleetDesktopApi = {
    ...baseClient,
    platform: options.platform ?? "linux",
    mobile: options.mobile,
    target: { id: machineId, local },
    ports: portsMock,
    webPreview: webPreviewMock,
    openExternal: openExternalMock,
  }

  const provide: Record<PropertyKey, unknown> = {
    [platformClientKey as symbol]: client,
  }
  if (!local) {
    provide[accountSessionKey as symbol] = {
      localMachineId: computed(() => "different-local-machine"),
      machines: ref([{
        id: machineId,
        teamId: "1",
        name: "remote-box",
        online,
        desktop: true,
        local: false,
      }]),
    }
  }

  let fleet!: ReturnType<typeof useFleetStore>
  const panelActive = ref(options.active ?? true)
  const Host = defineComponent({
    setup() {
      // Instantiate fleet inside component setup so inject(platformClientKey/accountSessionKey) resolves.
      fleet = useFleetStore(pinia)
      fleet.catalog = { ...catalogFixture(), machineId }
      fleet.localDesktopTarget = { id: machineId, name: local ? "local-box" : "remote-box", online, desktop: true }
      return () => h(SessionWebPreviewPanel, {
        sessionId,
        active: panelActive.value,
        initialTarget: options.initialTarget ?? null,
      })
    },
  })

  const wrapper = mount(Host, {
    attachTo: document.body,
    global: {
      plugins: [pinia, i18n],
      provide,
    },
  })
  mounted.push({ wrapper, pinia })
  await flushPromises()
  return {
    wrapper,
    panel: () => wrapper.getComponent(SessionWebPreviewPanel),
    setActive(next: boolean) { panelActive.value = next },
    fleet,
    startMock,
    retireForward,
    stopMock,
    allowOriginMock,
    revokeOriginMock,
    openDevToolsMock,
    openExternalMock,
  }
}

function attachFakeWebviewMethods(el: Element, options: { guestId?: number; canGoBack?: boolean; canGoForward?: boolean } = {}) {
  const goBack = vi.fn()
  const goForward = vi.fn()
  const reload = vi.fn()
  const loadURL = vi.fn(async () => {})
  let canBack = options.canGoBack ?? false
  let canFwd = options.canGoForward ?? false
  Object.assign(el, {
    canGoBack: () => canBack,
    canGoForward: () => canFwd,
    goBack,
    goForward,
    reload,
    loadURL,
    getWebContentsId: () => options.guestId ?? 77,
    setNavigationState(nextBack: boolean, nextForward: boolean) {
      canBack = nextBack
      canFwd = nextForward
    },
  })
  return { goBack, goForward, reload, loadURL }
}

test("defers connection until first activation and stays connected while hidden", async () => {
  const { wrapper, setActive, startMock, stopMock, allowOriginMock, revokeOriginMock } = await setup({
    local: false,
    online: true,
    active: false,
    initialTarget: { displayHost: "localhost", targetHost: "localhost", targetPort: 5173, path: "/" },
  })

  expect(startMock).not.toHaveBeenCalled()
  expect(allowOriginMock).not.toHaveBeenCalled()
  expect(wrapper.find("webview").exists()).toBe(false)

  setActive(true)
  await flushPromises()
  expect(startMock).toHaveBeenCalledTimes(1)
  expect(allowOriginMock).toHaveBeenCalledWith("http://127.0.0.1:41234")
  expect(wrapper.find("webview").exists()).toBe(true)

  setActive(false)
  await flushPromises()
  expect(stopMock).not.toHaveBeenCalled()
  expect(revokeOriginMock).not.toHaveBeenCalled()
})

test("desktop local machine connects directly in temp webview partition, syncs URL, and opens DevTools", async () => {
  const { wrapper, panel, startMock, allowOriginMock, openDevToolsMock } = await setup({
    local: true,
    online: true,
    initialTarget: { displayHost: "localhost", targetHost: "localhost", targetPort: 5173, path: "/" },
  })

  expect(startMock).not.toHaveBeenCalled()
  expect(allowOriginMock).toHaveBeenCalledWith("http://localhost:5173")

  const webview = wrapper.get("[data-web-preview-webview-host] webview")
  expect(webview.attributes("partition")).toBe("temp:deskfleet-web-preview")
  expect(webview.attributes("src")).toBe("http://localhost:5173/")

  const devtoolsButton = () => wrapper.get("[data-web-preview-devtools]")
  expect(devtoolsButton().attributes("aria-disabled")).toBe("true")

  const methods = attachFakeWebviewMethods(webview.element, { guestId: 99, canGoBack: true, canGoForward: false })
  webview.element.dispatchEvent(new Event("dom-ready"))
  await flushPromises()
  expect(devtoolsButton().attributes("aria-disabled")).toBeUndefined()
  expect(wrapper.get("[data-web-preview-back]").attributes("aria-disabled")).toBeUndefined()
  expect(wrapper.get("[data-web-preview-forward]").attributes("aria-disabled")).toBe("true")

  await devtoolsButton().trigger("click")
  expect(openDevToolsMock).toHaveBeenCalledWith(99)

  webview.element.dispatchEvent(Object.assign(new Event("did-navigate"), {
    url: "http://localhost:5173/docs?view=1",
    isMainFrame: true,
  }))
  webview.element.dispatchEvent(Object.assign(new Event("page-title-updated"), { title: "Docs" }))
  await flushPromises()

  expect((wrapper.get("[data-web-preview-address]").element as HTMLInputElement).value).toBe("http://localhost:5173/docs?view=1")
  expect(panel().emitted("change")?.at(-1)).toEqual([{
    displayHost: "localhost",
    targetHost: "localhost",
    targetPort: 5173,
    path: "/docs?view=1",
  }])
  expect(panel().emitted("title")?.at(-1)).toEqual(["Docs"])

  webview.element.dispatchEvent(Object.assign(new Event("page-title-updated"), { title: "http://127.0.0.1:41234/" }))
  await flushPromises()
  expect(panel().emitted("title")?.at(-1)).toEqual(["localhost:5173"])

  await wrapper.get("[data-web-preview-back]").trigger("click")
  expect(methods.goBack).toHaveBeenCalledTimes(1)
})

test("desktop remote machine tunnels via ports.start, hides random port from address bar, and cleans up on port change or unmount", async () => {
  const { wrapper, panel, startMock, stopMock, allowOriginMock, revokeOriginMock } = await setup({
    local: false,
    online: true,
    initialTarget: { displayHost: "localhost", targetHost: "localhost", targetPort: 5173, path: "/" },
  })

  expect(startMock).toHaveBeenCalledWith({
    target: { teamId: "1", machineId: "remote-machine-1" },
    targetHost: "localhost",
    targetPort: 5173,
  })
  expect(allowOriginMock).toHaveBeenCalledWith("http://127.0.0.1:41234")

  const webview = wrapper.get("webview")
  expect(webview.attributes("src")).toBe("http://127.0.0.1:41234/")
  expect((wrapper.get("[data-web-preview-address]").element as HTMLInputElement).value).toBe("http://localhost:5173")

  webview.element.dispatchEvent(Object.assign(new Event("did-navigate"), {
    url: "http://127.0.0.1:41234/docs",
    isMainFrame: false,
  }))
  webview.element.dispatchEvent(Object.assign(new Event("did-navigate"), {
    url: "http://127.0.0.1:9999/other",
    isMainFrame: true,
  }))
  await flushPromises()
  expect((wrapper.get("[data-web-preview-address]").element as HTMLInputElement).value).toBe("http://localhost:5173")

  webview.element.dispatchEvent(Object.assign(new Event("did-navigate"), {
    url: "http://127.0.0.1:41234/docs",
    isMainFrame: true,
  }))
  await flushPromises()
  expect((wrapper.get("[data-web-preview-address]").element as HTMLInputElement).value).toBe("http://localhost:5173/docs")
  expect(panel().emitted("change")?.at(-1)).toEqual([{
    displayHost: "localhost",
    targetHost: "localhost",
    targetPort: 5173,
    path: "/docs",
  }])

  await wrapper.get("[data-web-preview-address]").setValue("http://127.0.0.1:3000/api")
  await wrapper.get("form").trigger("submit")
  await flushPromises()

  expect(stopMock).toHaveBeenCalledWith("fwd-1")
  expect(revokeOriginMock).toHaveBeenCalledWith("grant-1")
  expect(startMock).toHaveBeenLastCalledWith({
    target: { teamId: "1", machineId: "remote-machine-1" },
    targetHost: "127.0.0.1",
    targetPort: 3000,
  })
  expect(allowOriginMock).toHaveBeenLastCalledWith("http://127.0.0.1:41235")
  expect(wrapper.get("webview").attributes("src")).toBe("http://127.0.0.1:41235/api")

  wrapper.unmount()
  await flushPromises()
  expect(stopMock).toHaveBeenCalledWith("fwd-2")
  expect(revokeOriginMock).toHaveBeenCalledWith("grant-2")
})

test("mobile mode renders iframe without DevTools, tracks path history, and opens external browser on actual tunnel URL", async () => {
  const { wrapper, startMock, allowOriginMock, openExternalMock } = await setup({
    platform: "web",
    mobile: true,
    local: false,
    online: true,
    withWebPreview: false,
  })

  expect(wrapper.find("[data-web-preview-empty]").exists()).toBe(true)
  expect(wrapper.find("[data-web-preview-devtools]").exists()).toBe(false)

  await wrapper.get("[data-web-preview-quick-port='5173']").trigger("click")
  await flushPromises()

  expect(startMock).toHaveBeenCalledTimes(1)
  expect(allowOriginMock).not.toHaveBeenCalled()
  const iframe = () => wrapper.get("[data-web-preview-iframe]")
  expect(iframe().attributes("src")).toBe("http://127.0.0.1:41234/")
  expect(wrapper.get("[data-web-preview-back]").attributes("aria-disabled")).toBe("true")

  await wrapper.get("[data-web-preview-address]").setValue(":5173/about")
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(startMock).toHaveBeenCalledTimes(1)
  expect(iframe().attributes("src")).toBe("http://127.0.0.1:41234/about")
  expect(wrapper.get("[data-web-preview-back]").attributes("aria-disabled")).toBeUndefined()

  await wrapper.get("[data-web-preview-back]").trigger("click")
  await flushPromises()
  expect(iframe().attributes("src")).toBe("http://127.0.0.1:41234/")
  expect(wrapper.get("[data-web-preview-forward]").attributes("aria-disabled")).toBeUndefined()

  await wrapper.get("[data-web-preview-forward]").trigger("click")
  await flushPromises()
  expect(iframe().attributes("src")).toBe("http://127.0.0.1:41234/about")

  await wrapper.get("[data-web-preview-external]").trigger("click")
  expect(openExternalMock).toHaveBeenCalledWith("http://127.0.0.1:41234/about")
})

test("rejects non-loopback or invalid preview addresses without opening tunnels or grants", async () => {
  const { wrapper, startMock, allowOriginMock } = await setup({ local: false, online: true })

  for (const invalid of ["https://localhost:5173", "http://example.com:3000", "99999"]) {
    await wrapper.get("[data-web-preview-address]").setValue(invalid)
    await wrapper.get("form").trigger("submit")
    await flushPromises()
    expect(wrapper.find("[data-web-preview-address-error]").exists()).toBe(true)
  }

  expect(startMock).not.toHaveBeenCalled()
  expect(allowOriginMock).not.toHaveBeenCalled()
  expect(wrapper.find("[data-web-preview-empty]").exists()).toBe(true)
})

test("shows offline state when remote machine is offline and connects once it returns online", async () => {
  const { wrapper, fleet, startMock } = await setup({
    local: false,
    online: false,
    initialTarget: { displayHost: "localhost", targetHost: "localhost", targetPort: 5173, path: "/" },
  })

  expect(wrapper.find("[data-web-preview-offline]").exists()).toBe(true)
  expect(startMock).not.toHaveBeenCalled()

  fleet.localDesktopTarget = { ...fleet.localDesktopTarget, online: true }
  await flushPromises()

  expect(wrapper.find("[data-web-preview-offline]").exists()).toBe(false)
  expect(startMock).toHaveBeenCalledTimes(1)
  expect(wrapper.find("webview").exists()).toBe(true)
})

test("address bar shows submit button when edited and commits dirty target on go click or reload", async () => {
  const { wrapper, startMock } = await setup({
    platform: "web",
    mobile: true,
    local: false,
    online: true,
    withWebPreview: false,
    initialTarget: { displayHost: "localhost", targetHost: "localhost", targetPort: 5173, path: "/" },
  })

  expect(wrapper.find("[data-web-preview-go]").exists()).toBe(false)
  expect(startMock).toHaveBeenCalledTimes(1)

  const addressInput = wrapper.get("[data-web-preview-address]")
  await addressInput.setValue("http://127.0.0.1:8080")
  await flushPromises()
  const goButton = wrapper.get("[data-web-preview-go]")
  await goButton.trigger("click")
  await flushPromises()

  expect(startMock).toHaveBeenCalledTimes(2)
  expect(startMock).toHaveBeenLastCalledWith({
    target: { teamId: "1", machineId: "remote-machine-1" },
    targetHost: "127.0.0.1",
    targetPort: 8080,
  })
  expect(wrapper.find("[data-web-preview-go]").exists()).toBe(false)
  expect(wrapper.get("[data-web-preview-iframe]").attributes("src")).toBe("http://127.0.0.1:41235/")

  await addressInput.setValue("http://127.0.0.1:8080/counter")
  await flushPromises()
  expect(wrapper.find("[data-web-preview-go]").exists()).toBe(true)
  await wrapper.get("[data-web-preview-reload]").trigger("click")
  await flushPromises()

  expect(startMock).toHaveBeenCalledTimes(2)
  expect(wrapper.find("[data-web-preview-go]").exists()).toBe(false)
  expect(wrapper.get("[data-web-preview-iframe]").attributes("src")).toBe("http://127.0.0.1:41235/counter")
})

test("re-establishes retired port forward on reload instead of hitting dead local port", async () => {
  const { wrapper, startMock, retireForward } = await setup({
    platform: "web",
    mobile: true,
    local: false,
    online: true,
    withWebPreview: false,
    initialTarget: { displayHost: "127.0.0.1", targetHost: "127.0.0.1", targetPort: 8080, path: "/" },
  })

  expect(startMock).toHaveBeenCalledTimes(1)
  expect(wrapper.get("[data-web-preview-iframe]").attributes("src")).toBe("http://127.0.0.1:41234/")

  expect(retireForward("fwd-1")).toBe(true)
  await wrapper.get("[data-web-preview-reload]").trigger("click")
  await flushPromises()

  expect(startMock).toHaveBeenCalledTimes(2)
  expect(wrapper.get("[data-web-preview-iframe]").attributes("src")).toBe("http://127.0.0.1:41235/")
})
