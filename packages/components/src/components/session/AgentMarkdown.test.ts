import { client } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { computed, ref } from "vue"
import { afterEach, expect, test, vi } from "vitest"
import type { FilesApi } from "../../../../client/src/files.ts"
import { i18n } from "../../i18n/index.ts"
import { agentResourceContextKey, type AgentResourceContext } from "../../services/agent-resources.ts"
import AgentMarkdown from "./AgentMarkdown.vue"

const originalFiles = client.files
let wrapper: VueWrapper | undefined
const context = () => ref<AgentResourceContext>({ target: { kind: "machine", machineId: "42", teamId: "7" }, sessionId: "12" })
function render(files: Partial<FilesApi>, text: string, value = context()) {
  client.files = files as FilesApi
  wrapper = mount(AgentMarkdown, { props: { text }, global: { plugins: [i18n], provide: { [agentResourceContextKey as symbol]: computed(() => value.value) } } })
  return wrapper
}
afterEach(() => { wrapper?.unmount(); wrapper = undefined; client.files = originalFiles })

test("loads images from the executing machine, shares reads through streamed text and releases URLs", async () => {
  let resolve!: (value: { data: Uint8Array; name: string; mimeType: string }) => void
  const readResource = vi.fn(() => new Promise<{ data: Uint8Array; name: string; mimeType: string }>(done => { resolve = done }))
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:chart")
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  const view = render({ readResource }, "![Chart](/tmp/chart.png)")
  await flushPromises()
  await view.setProps({ text: "![Chart](/tmp/chart.png)\n\nMore text" })
  expect(readResource).toHaveBeenCalledExactlyOnceWith({ target: { kind: "machine", machineId: "42", teamId: "7" }, sessionId: "12", uri: "/tmp/chart.png" })
  resolve({ data: new Uint8Array([1]), name: "chart.png", mimeType: "image/png" })
  await flushPromises()
  expect(view.get("img").attributes("src")).toBe("blob:chart")
  expect(create).toHaveBeenCalledOnce()
  await view.setProps({ text: "Image removed" })
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:chart")
})

test.each(["image/bmp", "image/vnd.microsoft.icon", "image/x-icon"])("renders remote %s images as typed Blob URLs", async mimeType => {
  const readResource = vi.fn().mockResolvedValue({ data: new Uint8Array([1, 2, 3]), name: "preview", mimeType })
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview")
  const view = render({ readResource }, "![Preview](/tmp/preview)")
  await flushPromises()
  expect(view.get("img").attributes("src")).toBe("blob:preview")
  const blob = create.mock.calls[0]![0] as Blob
  expect(blob.type).toBe(mimeType)
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  expect(view.find("[data-resource-retry]").exists()).toBe(false)
})

test("discards image completion after changing machines and keeps file links on trusted context", async () => {
  let resolve!: (value: { data: Uint8Array; name: string; mimeType: string }) => void
  const readResource = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done })).mockRejectedValue(new Error("Machine offline"))
  const saveResource = vi.fn().mockResolvedValue("transfer-1")
  const create = vi.spyOn(URL, "createObjectURL")
  const resourceContext = context()
  const view = render({ readResource, saveResource }, "![Chart](chart.png) [Report](file:///tmp/report.pdf)", resourceContext)
  await flushPromises()
  resourceContext.value = { target: { kind: "machine", machineId: "99", teamId: "7" }, sessionId: "12" }
  await flushPromises()
  resolve({ data: new Uint8Array([1]), name: "chart.png", mimeType: "image/png" })
  await flushPromises()
  expect(create).not.toHaveBeenCalled()
  expect(view.get("[data-resource-retry]").attributes("title")).toContain("Machine offline")
  await view.get("a[data-resource-link]").trigger("click")
  expect(saveResource).toHaveBeenCalledWith({ ...resourceContext.value, uri: "file:///tmp/report.pdf" })
})

test("late image completion after unmount creates no retained URL", async () => {
  let resolve!: (value: { data: Uint8Array; name: string; mimeType: string }) => void
  const readResource = vi.fn(() => new Promise<{ data: Uint8Array; name: string; mimeType: string }>(done => { resolve = done }))
  const create = vi.spyOn(URL, "createObjectURL")
  const view = render({ readResource }, "![Chart](chart.png)")
  await flushPromises()
  view.unmount(); wrapper = undefined
  resolve({ data: new Uint8Array([1]), name: "chart.png", mimeType: "image/png" })
  await flushPromises()
  expect(create).not.toHaveBeenCalled()
})
