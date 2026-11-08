import { getClient } from "@deskfleet/client/platform"
import { flushPromises, mount } from "@vue/test-utils"
import { computed } from "vue"
import { expect, test, vi } from "vitest"
import type { FileResourceRequest, FilesApi } from "../../../../client/src/files.ts"
import { i18n } from "../../i18n/index.ts"
import { platformClientKey } from "../../composables/usePlatformClient.ts"
import { agentResourceContextKey } from "../../services/agent-resources.ts"
import { previewResourceRequestFromQuery } from "../../services/preview.ts"
import AgentMarkdown from "./AgentMarkdown.vue"
import AgentResourceViewer from "./AgentResourceViewer.vue"
import OfficePreview from "./OfficePreview.vue"
import PreviewViewer from "./PreviewViewer.vue"

// Verify deskfleet's file routing here; the Office adapter owns parser lifecycle tests.
vi.mock("./OfficePreview.vue", () => ({ __esModule: true, default: {
  props: ["kind", "src", "data", "mode"],
  template: '<div data-office-preview :data-kind="kind" />',
} }))

const request: FileResourceRequest = {
  target: { kind: "machine", teamId: "team", machineId: "machine" },
  sessionId: "session",
  uri: "/work/演示方案.pptx",
}
const global = { plugins: [i18n], stubs: { Teleport: { inheritAttrs: false, template: "<slot />" } } }

test.each(["docx", "xlsx", "pptx"] as const)("routes remote %s bytes to Office preview and retains a scoped source for new windows", async kind => {
  const name = `preview.${kind}`
  const selected = { ...request, uri: `/work/${name}` }
  const data = new Uint8Array([0x50, 0x4b, 1, 2])
  const readResource = vi.fn().mockResolvedValue({ name, data, mimeType: "application/octet-stream" })
  const resolveResource = vi.fn().mockResolvedValue({ name, path: selected.uri, kind: "file" })
  const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue(`blob:${kind}`)
  const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  const open = vi.spyOn(window, "open").mockReturnValue(null)
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
  const view = mount(AgentResourceViewer, {
    props: { api: { readResource, resolveResource } as unknown as FilesApi, request: selected, mode: "tab" },
    global, attachTo: document.body,
  })
  await flushPromises()
  await vi.waitFor(() => expect(view.findComponent(OfficePreview).exists()).toBe(true))
  expect(resolveResource).toHaveBeenCalledExactlyOnceWith(selected)
  expect(readResource).toHaveBeenCalledExactlyOnceWith(selected, { onProgress: expect.any(Function) })
  expect(view.getComponent(OfficePreview).props()).toMatchObject({ kind, src: `blob:${kind}`, data, mode: "tab" })
  expect(view.find("pre").exists()).toBe(false)
  expect(createUrl).toHaveBeenCalledOnce()

  await view.get('[data-preview-action="more"]').trigger("click")
  await flushPromises()
  await view.get('[data-preview-action="download"]').trigger("click")
  expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(name)
  await view.get('[data-preview-action="more"]').trigger("click")
  await flushPromises()
  await view.get('[data-preview-action="show-in-new-window"]').trigger("click")
  const url = String(open.mock.calls[0]![0])
  const params = new URLSearchParams(url.split("?")[1])
  expect(params.get("content")).toBe(selected.uri)
  expect(params.get("kind")).toBe(kind)
  expect(params.get("sessionId")).toBe(selected.sessionId)
  expect(previewResourceRequestFromQuery(key => params.get(key))).toEqual(selected)
  expect(url).not.toContain("blob:")
  view.unmount()
  expect(revokeUrl).toHaveBeenCalledWith(`blob:${kind}`)
})

test("loads an Office resource in a reopened preview using the existing scoped file API", async () => {
  const data = new Uint8Array([0x50, 0x4b, 1, 2])
  const readResource = vi.fn().mockResolvedValue({ name: "演示方案.pptx", data, mimeType: "application/octet-stream", canOpen: true })
  const openResource = vi.fn().mockResolvedValue(undefined)
  const api = { ...getClient().files!, readResource, openResource }
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:slides")
  const view = mount(PreviewViewer, {
    props: { kind: "pptx", content: request.uri, resourceRequest: request, mode: "window", api },
    global,
  })
  await flushPromises()
  await vi.waitFor(() => expect(view.findComponent(OfficePreview).exists()).toBe(true))
  expect(readResource).toHaveBeenCalledExactlyOnceWith(request)
  expect(view.getComponent(OfficePreview).props()).toMatchObject({ kind: "pptx", src: "blob:slides", data, mode: "window" })
  await view.get('[data-preview-action="more"]').trigger("click")
  await flushPromises()
  expect(view.find('[data-preview-action="download"]').exists()).toBe(false)
  await view.get('[data-preview-action="open"]').trigger("click")
  expect(openResource).toHaveBeenCalledExactlyOnceWith(request)
  view.unmount()
})

test.each(["dialog", "tab"] as const)("opens local Office files with the scoped native API in %s mode", async mode => {
  const data = new Uint8Array([0x50, 0x4b])
  const openResource = vi.fn().mockResolvedValue(undefined)
  const saveResource = vi.fn()
  const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:local-slides")
  const api = {
    resolveResource: vi.fn().mockResolvedValue({ name: "preview.pptx", path: request.uri, kind: "file", canOpen: true }),
    readResource: vi.fn().mockResolvedValue({ name: "preview.pptx", data, mimeType: "application/octet-stream", canOpen: true }),
    openResource, saveResource,
  } as unknown as FilesApi
  const view = mount(AgentResourceViewer, { props: { api, request, mode }, global, attachTo: document.body })
  await flushPromises()
  await vi.waitFor(() => expect(view.findComponent(OfficePreview).exists()).toBe(true))
  await view.get('[data-preview-action="more"]').trigger("click")
  await flushPromises()
  expect(view.find('[data-preview-action="download"]').exists()).toBe(false)
  const actions = view.findAll('[data-preview-action="open"]')
  expect(actions).toHaveLength(mode === "dialog" ? 2 : 1)
  for (const action of actions) await action.trigger("click")
  expect(openResource).toHaveBeenCalledTimes(actions.length)
  expect(openResource).toHaveBeenCalledWith(request)
  expect(saveResource).not.toHaveBeenCalled()
  expect(download).not.toHaveBeenCalled()
  view.unmount()
})

test("Markdown Office embeds retain their scoped request and native Open action", async () => {
  const selected = { ...request, uri: encodeURI(request.uri) }
  const openResource = vi.fn().mockRejectedValue(new Error("No application is associated with this file"))
  const readResource = vi.fn().mockResolvedValue({
    name: "preview.pptx", data: new Uint8Array([0x50, 0x4b]), canOpen: true,
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  })
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:inline-slides")
  const view = mount(AgentMarkdown, {
    props: { text: "![Synthetic slides](/work/演示方案.pptx)" },
    global: { ...global, provide: {
      [platformClientKey as symbol]: { ...getClient(), files: { ...getClient().files, readResource, openResource } },
      [agentResourceContextKey as symbol]: computed(() => ({ target: request.target, sessionId: request.sessionId })),
    } }, attachTo: document.body,
  })
  await flushPromises()
  await vi.waitFor(() => expect(view.findComponent(OfficePreview).exists()).toBe(true))
  expect(readResource).toHaveBeenCalledExactlyOnceWith(selected)
  await view.get('[data-preview-action="more"]').trigger("click")
  await flushPromises()
  expect(view.find('[data-preview-action="download"]').exists()).toBe(false)
  await view.get('[data-preview-action="open"]').trigger("click")
  await flushPromises()
  expect(openResource).toHaveBeenCalledExactlyOnceWith(selected)
  expect(view.get('[role="alert"]').text()).toBe("No application is associated with this file")
  view.unmount()
})

test.each([
  { content: "https://example.test/preview.docx", host: "resource-0", data: undefined, expected: "https://example.test/preview.docx" },
  { content: "blob:document", host: "/work/preview.docx", data: new Uint8Array([0x50, 0x4b]), expected: "/work/preview.docx" },
])("preserves the Office source $expected when opening an inline preview separately", async ({ content, host, data, expected }) => {
  const open = vi.spyOn(window, "open").mockReturnValue(null)
  const view = mount(PreviewViewer, {
    props: { kind: "docx", content, data },
    attrs: { "data-preview": host },
    global, attachTo: document.body,
  })
  await flushPromises()
  await view.get('[data-preview-action="more"]').trigger("click")
  await flushPromises()
  await view.get('[data-preview-action="show-in-new-window"]').trigger("click")
  expect(new URLSearchParams(String(open.mock.calls[0]![0]).split("?")[1]).get("content")).toBe(expected)
  view.unmount()
})
