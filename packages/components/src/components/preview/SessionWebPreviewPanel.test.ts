import { getClient } from "@deskfleet/client/platform"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import type { PortForward } from "@deskfleet/client/ports"
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
  vi.restoreAllMocks()
  for (const { wrapper, pinia } of mounted.splice(0)) {
    wrapper.unmount()
    disposePinia(pinia)
  }
})

interface SetupOptions {
  platform?: DeskfleetDesktopApi["platform"]
  local?: boolean
  online?: boolean
  initialUrl?: string | null
}

async function setup(options: SetupOptions = {}) {
  const pinia = createPinia()
  const local = options.local ?? true
  const online = options.online ?? true
  const machineId = local ? "9007199254740999" : "remote-machine-1"
  let forwardSeq = 0

  const activeForwards = new Map<string, PortForward>()
  const startMock = vi.fn(async (input: Parameters<NonNullable<DeskfleetDesktopApi["ports"]>["start"]>[0]) => {
    const id = `fwd-${++forwardSeq}`
    const forward: PortForward = {
      id,
      target: input.target,
      targetHost: input.targetHost ?? "127.0.0.1",
      targetPort: input.targetPort,
      localHost: "127.0.0.1",
      localPort: 41233 + forwardSeq,
    }
    activeForwards.set(id, forward)
    return forward
  })
  const stopMock = vi.fn(async (id: string) => { activeForwards.delete(id) })

  const client: DeskfleetDesktopApi = {
    ...getClient(),
    platform: options.platform ?? "linux",
    target: { id: machineId, local },
    ports: {
      start: startMock,
      stop: stopMock,
      list: async () => [...activeForwards.values()],
    },
  }

  const provide: Record<PropertyKey, unknown> = { [platformClientKey as symbol]: client }
  if (!local) {
    provide[accountSessionKey as symbol] = {
      localMachineId: computed(() => "different-local-machine"),
      machines: ref([{ id: machineId, teamId: "1", name: "remote-box", online, desktop: true, local: false }]),
    }
  }

  let fleet!: ReturnType<typeof useFleetStore>
  const Host = defineComponent({
    setup() {
      fleet = useFleetStore(pinia)
      fleet.catalog = { ...catalogFixture(), machineId }
      fleet.localDesktopTarget = { id: machineId, name: local ? "local-box" : "remote-box", online, desktop: true }
      return () => h(SessionWebPreviewPanel, { sessionId, initialUrl: options.initialUrl ?? null })
    },
  })

  const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia, i18n], provide } })
  mounted.push({ wrapper, pinia })
  await flushPromises()
  return {
    wrapper,
    panel: () => wrapper.getComponent(SessionWebPreviewPanel),
    retireForward: (id: string) => activeForwards.delete(id),
    fleet,
    startMock,
    stopMock,
  }
}

test("desktop local connects directly in a sandboxed iframe, commits address edits, and opens externally", async () => {
  const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null)
  const { wrapper, panel, startMock } = await setup({
    local: true,
    online: true,
    initialUrl: "http://localhost:5173",
  })

  expect(startMock).not.toHaveBeenCalled()
  const iframe = wrapper.get("[data-web-preview-iframe]")
  expect(iframe.attributes("src")).toBe("http://localhost:5173/")
  expect(iframe.attributes("sandbox")).toBe("allow-scripts allow-same-origin allow-forms allow-modals allow-downloads")
  expect(iframe.attributes("title")).toBe("localhost:5173")
  expect(wrapper.find("[data-web-preview-go]").exists()).toBe(false)

  await wrapper.get("[data-web-preview-address]").setValue("http://localhost:5173/docs?view=1")
  await flushPromises()
  await wrapper.get("[data-web-preview-go]").trigger("click")
  await flushPromises()

  expect(wrapper.get("[data-web-preview-iframe]").attributes("src")).toBe("http://localhost:5173/docs?view=1")
  expect(panel().emitted("change")?.at(-1)).toEqual(["http://localhost:5173/docs?view=1"])

  await wrapper.get("[data-web-preview-external]").trigger("click")
  expect(windowOpen).toHaveBeenCalledWith("http://localhost:5173/docs?view=1", "_blank", "noopener,noreferrer")
})

test("desktop remote tunnels via ports.start, recovers retired forwards, and cleans up on change or unmount", async () => {
  const { wrapper, panel, startMock, stopMock, retireForward } = await setup({
    local: false,
    online: true,
    initialUrl: "http://localhost:5173",
  })

  expect(startMock).toHaveBeenCalledWith({
    target: { teamId: "1", machineId: "remote-machine-1" },
    targetHost: "localhost",
    targetPort: 5173,
  })

  expect(wrapper.get("[data-web-preview-iframe]").attributes("src")).toBe("http://127.0.0.1:41234/")
  expect((wrapper.get("[data-web-preview-address]").element as HTMLInputElement).value).toBe("http://localhost:5173")

  await wrapper.get("[data-web-preview-address]").setValue("http://localhost:5173/docs")
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(startMock).toHaveBeenCalledTimes(1)
  expect(wrapper.get("[data-web-preview-iframe]").attributes("src")).toBe("http://127.0.0.1:41234/docs")
  expect(panel().emitted("change")?.at(-1)).toEqual(["http://localhost:5173/docs"])

  expect(retireForward("fwd-1")).toBe(true)
  await wrapper.get("[data-web-preview-reload]").trigger("click")
  await flushPromises()
  expect(startMock).toHaveBeenCalledTimes(2)
  expect(wrapper.get("[data-web-preview-iframe]").attributes("src")).toBe("http://127.0.0.1:41235/docs")

  await wrapper.get("[data-web-preview-address]").setValue("http://127.0.0.1:3000/api")
  await wrapper.get("form").trigger("submit")
  await flushPromises()

  expect(stopMock).toHaveBeenCalledWith("fwd-1")
  expect(stopMock).toHaveBeenCalledWith("fwd-2")
  expect(startMock).toHaveBeenLastCalledWith({
    target: { teamId: "1", machineId: "remote-machine-1" },
    targetHost: "127.0.0.1",
    targetPort: 3000,
  })
  expect(wrapper.get("[data-web-preview-iframe]").attributes("src")).toBe("http://127.0.0.1:41236/api")

  wrapper.unmount()
  await flushPromises()
  expect(stopMock).toHaveBeenCalledWith("fwd-3")
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
  expect(wrapper.find("[data-web-preview-iframe]").exists()).toBe(true)
})
