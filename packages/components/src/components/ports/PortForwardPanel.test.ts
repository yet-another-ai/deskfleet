import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { reactive } from "vue"
import { afterEach, expect, test, vi } from "vitest"
import type { PortForward, PortForwardRequest, PortsApi } from "../../../../client/src/ports.ts"
import { i18n } from "../../i18n/index.ts"
import { deferred } from "../../test/desktop-media.ts"
import { selectOption } from "../../test/controls.ts"
import PortForwardPanel from "./PortForwardPanel.vue"

const target = { teamId: "team", machineId: "machine" }
const forward = (id = "forward", patch: Partial<PortForward> = {}): PortForward => ({
  id, target: { ...target }, localHost: "127.0.0.1", localPort: 53000, targetHost: "127.0.0.1", targetPort: 3000, ...patch,
})
let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.useRealTimers(); vi.restoreAllMocks() })

async function setup(options: { forwards?: PortForward[]; active?: boolean; online?: boolean } = {}) {
  let rows = options.forwards ?? []
  const api: PortsApi = {
    list: vi.fn(async () => structuredClone(rows)),
    start: vi.fn(async (request: PortForwardRequest) => {
      const value = forward("new", { ...structuredClone(request), localPort: request.localPort || 54000, targetHost: request.targetHost ?? "127.0.0.1" })
      rows = [...rows, value]
      return value
    }),
    stop: vi.fn(async (id: string) => { rows = rows.filter(row => row.id !== id) }),
  }
  wrapper = mount(PortForwardPanel, {
    props: { api, target: reactive({ ...target }), machineName: "Build machine", active: options.active ?? true, online: options.online ?? true },
    attachTo: document.body,
    global: { plugins: [i18n], stubs: { teleport: { inheritAttrs: false, template: "<slot />" } } },
  })
  await flushPromises()
  return { view: wrapper, api }
}
async function add(view: VueWrapper, remote = "3000", local = "") {
  await view.get("[data-ports-add]").trigger("click")
  await flushPromises()
  await view.get('input[name="targetPort"]').setValue(remote)
  await view.get('input[name="localPort"]').setValue(local)
}

test("shows only the current Team and Machine's forwards", async () => {
  const { view } = await setup({ forwards: [
    forward(), forward("other-team", { target: { ...target, teamId: "other" } }),
    forward("other-machine", { target: { ...target, machineId: "other" } }),
  ] })
  expect(view.findAll("[data-forward-id]").map(row => row.attributes("data-forward-id"))).toEqual(["forward"])
  expect(view.text()).toContain("127.0.0.1:53000")
  expect(view.text()).toContain("127.0.0.1:3000")
})

test("starts a forwarding with a cloneable DTO and displays the actual assigned local port", async () => {
  const { view, api } = await setup()
  await add(view)
  await view.get("[data-ports-form]").trigger("submit")
  await flushPromises()
  const request = vi.mocked(api.start).mock.calls[0]![0]
  expect(structuredClone(request)).toEqual({ target, targetHost: "127.0.0.1", targetPort: 3000, localPort: 0 })
  expect(view.get('[data-forward-id="new"]').text()).toContain("127.0.0.1:54000")
})

test("supports IPv6 loopback destinations and a chosen local port", async () => {
  const { view, api } = await setup()
  await add(view, "5432", "15432")
  await selectOption(view, '[data-control-name="targetHost"]', "::1")
  await view.get("[data-ports-form]").trigger("submit")
  await flushPromises()
  expect(api.start).toHaveBeenCalledExactlyOnceWith({ target, targetHost: "::1", targetPort: 5432, localPort: 15432 })
  expect(view.get('[data-forward-id="new"]').text()).toContain("[::1]:5432")
})

test.each([["0", ""], ["65536", ""], ["3000.5", ""], ["3000", "0"], ["3000", "65536"]])("rejects invalid target/local ports %s/%s", async (remote, local) => {
  const { view, api } = await setup()
  await add(view, remote, local)
  await view.get("[data-ports-form]").trigger("submit")
  expect(api.start).not.toHaveBeenCalled()
  expect(view.get('[role="alert"]').text()).toContain("65535")
})

test("keeps failed starts in the dialog for correction and blocks duplicate submissions", async () => {
  const { view, api } = await setup()
  const pending = deferred<PortForward>()
  vi.mocked(api.start).mockReturnValueOnce(pending.promise)
  await add(view, "3000", "3000")
  await view.get("[data-ports-form]").trigger("submit")
  await view.get("[data-ports-form]").trigger("submit")
  expect(api.start).toHaveBeenCalledTimes(1)
  pending.reject(new Error("Local port is in use"))
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe("Local port is in use")
  expect(view.get('input[name="targetPort"]').element).toHaveProperty("value", "3000")
  await view.get('input[name="localPort"]').setValue("3001")
  await view.get("[data-ports-form]").trigger("submit")
  await flushPromises()
  expect(view.get('[data-forward-id="new"]').text()).toContain("127.0.0.1:3001")
})

test("allows stopping an existing forward while the machine is offline, retaining failures", async () => {
  const { view, api } = await setup({ forwards: [forward()], online: false })
  expect(view.get("[data-ports-add]").attributes("disabled")).toBeDefined()
  vi.mocked(api.stop).mockRejectedValueOnce(new Error("Stop failed"))
  await view.get("[data-ports-stop]").trigger("click")
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe("Stop failed")
  expect(view.find('[data-forward-id="forward"]').exists()).toBe(true)
  await view.get("[data-ports-stop]").trigger("click")
  await flushPromises()
  expect(api.stop).toHaveBeenCalledWith("forward")
  expect(view.find('[data-forward-id="forward"]').exists()).toBe(false)
})

test("polls only while visible and never stops a forward on navigation or unmount", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  const { view, api } = await setup({ forwards: [forward()] })
  expect(api.list).toHaveBeenCalledTimes(1)
  vi.mocked(api.list).mockResolvedValueOnce([])
  await vi.advanceTimersByTimeAsync(3000)
  await flushPromises()
  expect(view.find("[data-forward-id]").exists()).toBe(false)
  await view.setProps({ active: false })
  await vi.advanceTimersByTimeAsync(9000)
  expect(api.list).toHaveBeenCalledTimes(2)
  await view.setProps({ active: true })
  await flushPromises()
  expect(api.list).toHaveBeenCalledTimes(3)
  view.unmount(); wrapper = undefined
  await vi.advanceTimersByTimeAsync(9000)
  expect(api.list).toHaveBeenCalledTimes(3)
  expect(api.stop).not.toHaveBeenCalled()
})
test("does not let an older list read restore a stopped forward", async () => {
  const { view, api } = await setup({ forwards: [forward()] })
  const oldList = deferred<PortForward[]>()
  vi.mocked(api.list).mockReturnValueOnce(oldList.promise)
  await view.get("[data-ports-refresh]").trigger("click")
  await view.get("[data-ports-stop]").trigger("click")
  await flushPromises()
  oldList.resolve([forward()])
  await flushPromises()
  expect(view.find("[data-forward-id]").exists()).toBe(false)
})

test("retains the empty state and Add action during background refresh", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  const { view, api } = await setup()
  const refresh = deferred<PortForward[]>()
  vi.mocked(api.list).mockReturnValueOnce(refresh.promise)
  await vi.advanceTimersByTimeAsync(3000)
  await flushPromises()
  expect(view.find("[data-ports-add]").exists()).toBe(true)
  expect(view.text()).toContain("Your remote services, available locally")
  expect(view.text()).not.toContain("Loading forwards")
  refresh.resolve([])
  await flushPromises()
})

test("copies the local address and lets a failed clipboard write be retried", async () => {
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("Denied")).mockResolvedValueOnce()
  const { view } = await setup({ forwards: [forward()] })
  await view.get("[data-ports-copy]").trigger("click")
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe("Could not copy the address.")
  await view.get("[data-ports-copy]").trigger("click")
  await flushPromises()
  expect(writeText).toHaveBeenLastCalledWith("127.0.0.1:53000")
  expect(view.find('[role="alert"]').exists()).toBe(false)
  expect(view.get("[data-ports-copy]").attributes("aria-label")).toBe("Copied")
})

test("discards a pending start result when the target scope changes without stopping its resource", async () => {
  const { view, api } = await setup()
  const start = deferred<PortForward>()
  vi.mocked(api.start).mockReturnValueOnce(start.promise)
  await add(view)
  await view.get("[data-ports-form]").trigger("submit")
  await view.setProps({ target: { teamId: "other", machineId: target.machineId } })
  start.resolve(forward("old-team"))
  await flushPromises()
  expect(view.find("[data-forward-id]").exists()).toBe(false)
  expect(api.stop).not.toHaveBeenCalled()
})

test("preserves forwards and the add draft when a roster refresh replaces the same target", async () => {
  const { view, api } = await setup({ forwards: [forward()] })
  await add(view, "5432", "15432")
  await view.setProps({ target: { ...target } })
  await flushPromises()

  expect(view.get('[role="dialog"]').attributes("inert")).toBeUndefined()
  expect(view.get('input[name="targetPort"]').element).toHaveProperty("value", "5432")
  expect(view.get('input[name="localPort"]').element).toHaveProperty("value", "15432")
  expect(view.get('[data-forward-id="forward"]').text()).toContain("127.0.0.1:53000")
  expect(api.list).toHaveBeenCalledTimes(1)
})

test("preserves a pending start and its result when a roster refresh replaces the same target", async () => {
  const { view, api } = await setup({ forwards: [forward()] })
  const start = deferred<PortForward>()
  vi.mocked(api.start).mockReturnValueOnce(start.promise)
  await add(view, "5432", "15432")
  await view.get("[data-ports-form]").trigger("submit")
  await view.setProps({ target: { ...target } })
  await flushPromises()

  expect(view.get("[data-ports-start]").attributes("disabled")).toBeDefined()
  expect(view.get('[role="dialog"]').attributes("inert")).toBeUndefined()
  await view.get("[data-ports-form]").trigger("submit")
  expect(api.start).toHaveBeenCalledTimes(1)
  expect(api.list).toHaveBeenCalledTimes(1)

  start.resolve(forward("new", { targetPort: 5432, localPort: 15432 }))
  await flushPromises()
  expect(view.get('[data-forward-id="new"]').text()).toContain("127.0.0.1:15432")
  expect(view.find('[data-forward-id="forward"]').exists()).toBe(true)
})
