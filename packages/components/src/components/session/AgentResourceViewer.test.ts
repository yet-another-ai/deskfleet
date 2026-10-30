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

test("highlights and scrolls to the requested line", async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {})
  const view = render({ resolveResource: vi.fn().mockResolvedValue({ name: "main.ts", path: "/work/main.ts", kind: "file" }), readResource: vi.fn().mockResolvedValue({ name: "main.ts", data: new TextEncoder().encode("first\nsecond\nthird"), mimeType: "text/plain" }) }, { ...request, uri: "main.ts:2:4" })
  await flushPromises()
  expect(view.get("pre .bg-ui-hover").text()).toContain("second")
  expect(scroll).toHaveBeenCalledWith({ block: "center" })
  view.unmount()
})
