import { flushPromises, mount } from "@vue/test-utils"
import { expect, test, vi } from "vitest"
import type { FilesApi, FileResourceRequest } from "../../../../client/src/files.ts"
import { i18n } from "../../i18n/index.ts"
import AgentResourceViewer from "./AgentResourceViewer.vue"

const request: FileResourceRequest = { target: { kind: "machine", teamId: "team", machineId: "machine" }, sessionId: "session", uri: "src" }
function render(api: Partial<FilesApi>, selected = request) {
  return mount(AgentResourceViewer, { props: { api: api as FilesApi, request: selected }, global: { plugins: [i18n], stubs: { Teleport: { template: "<slot />" } } }, attachTo: document.body })
}

test("opens a directory on the session machine without prompting for a download", async () => {
  const resolveResource = vi.fn().mockResolvedValue({ name: "src", path: "/work/src", kind: "directory" })
  const list = vi.fn().mockResolvedValue({ path: "/work/src", parentPath: "/work", homePath: "/", roots: [], entries: [] })
  const saveResource = vi.fn()
  const view = render({ resolveResource, list, saveResource })
  await flushPromises()
  expect(resolveResource).toHaveBeenCalledWith(request)
  expect(list).toHaveBeenCalledWith(request.target, "/work/src")
  expect(saveResource).not.toHaveBeenCalled()
  view.unmount()
})

test("previews a file and downloads only on explicit action", async () => {
  const resolveResource = vi.fn().mockResolvedValue({ name: "main.vue", path: "/work/main.vue", kind: "file" })
  const readResource = vi.fn().mockResolvedValue({ name: "main.vue", data: new TextEncoder().encode("hello"), mimeType: "application/octet-stream" })
  const saveResource = vi.fn().mockResolvedValue("job")
  const view = render({ resolveResource, readResource, saveResource })
  await flushPromises()
  expect(view.text()).toContain("hello")
  expect(saveResource).not.toHaveBeenCalled()
  await view.findAll("button").find(button => button.text() === "Download")!.trigger("click")
  expect(saveResource).toHaveBeenCalledWith(request)
  view.unmount()
})

test("shows resolution errors without requesting a destination", async () => {
  const saveResource = vi.fn()
  const view = render({ resolveResource: vi.fn().mockRejectedValue(new Error("Machine offline")), saveResource })
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toContain("Machine offline")
  expect(saveResource).not.toHaveBeenCalled()
  view.unmount()
})

test.each([
  "main.ts:2", "main.ts:2:4", "main.ts#L2", "main.ts#L2-L2",
  "C:/work/main.ts:2:4", "file:///work/main.ts#L2", "main.ts:3#L2",
])("highlights and scrolls to the requested line in %s", async uri => {
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {})
  const resolveResource = vi.fn().mockResolvedValue({ name: "main.ts", path: "/work/main.ts", kind: "file" })
  const readResource = vi.fn().mockResolvedValue({ name: "main.ts", data: new TextEncoder().encode("first\nsecond\nthird"), mimeType: "text/plain" })
  const selected = { ...request, uri }
  const view = render({ resolveResource, readResource }, selected)
  await flushPromises()
  expect(view.findAll("pre .bg-ui-hover").map(line => line.text())).toEqual(["second"])
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "center" })
  expect(scroll.mock.contexts[0]).toBe(view.get("pre .bg-ui-hover").element)
  expect(resolveResource).toHaveBeenCalledWith(selected)
  expect(readResource).toHaveBeenCalledWith(selected)
  view.unmount()
})

test("highlights a requested line range and scrolls to its first line", async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {})
  const view = render({ resolveResource: vi.fn().mockResolvedValue({ name: "main.ts", path: "/work/main.ts", kind: "file" }), readResource: vi.fn().mockResolvedValue({ name: "main.ts", data: new TextEncoder().encode("first\nsecond\nthird\nfourth"), mimeType: "text/plain" }) }, { ...request, uri: "main.ts#L2-L3" })
  await flushPromises()
  const highlighted = view.findAll("pre .bg-ui-hover")
  expect(highlighted.map(line => line.text())).toEqual(["second", "third"])
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "center" })
  expect(scroll.mock.contexts[0]).toBe(highlighted[0]!.element)
  view.unmount()
})

test.each(["main.ts#L20", "main.ts#L3-L2", "literal%23L2", "literal%3A2"])("does not select another line for %s", async uri => {
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {})
  const view = render({ resolveResource: vi.fn().mockResolvedValue({ name: "main.ts", path: "/work/main.ts", kind: "file" }), readResource: vi.fn().mockResolvedValue({ name: "main.ts", data: new TextEncoder().encode("first\nsecond\nthird"), mimeType: "text/plain" }) }, { ...request, uri })
  await flushPromises()
  expect(view.text()).toContain("second")
  expect(view.find("pre .bg-ui-hover").exists()).toBe(false)
  expect(scroll).not.toHaveBeenCalled()
  view.unmount()
})
