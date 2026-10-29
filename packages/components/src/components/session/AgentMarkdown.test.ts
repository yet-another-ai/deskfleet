import { client } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { computed, ref } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { FilesApi } from "../../../../client/src/files.ts"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import { agentResourceContextKey, type AgentResourceContext } from "../../services/agent-resources.ts"
import * as mermaidService from "../../services/mermaid.ts"
import { APPEARANCE_STORAGE_KEY, useAppearanceStore } from "../../stores/appearance.ts"
import { mermaidSidebarTabs, resetMermaidSidebarTabs } from "../../stores/layout.ts"
import AgentMarkdown from "./AgentMarkdown.vue"
import MermaidViewer from "./MermaidViewer.vue"

const originalFiles = client.files
let wrapper: VueWrapper | undefined
let pinia: ReturnType<typeof createPinia>
beforeEach(() => { localStorage.removeItem(APPEARANCE_STORAGE_KEY); pinia = createPinia(); setActivePinia(pinia) })
const context = () => ref<AgentResourceContext>({ target: { kind: "machine", machineId: "42", teamId: "7" }, sessionId: "12" })
function render(files: Partial<FilesApi>, text: string, value = context()) {
  client.files = files as FilesApi
  wrapper = mount(AgentMarkdown, {
    attachTo: document.body,
    props: { text },
    global: {
      plugins: [i18n, router],
      stubs: { Teleport: { inheritAttrs: false, template: "<slot />" } },
      provide: { [agentResourceContextKey as symbol]: computed(() => value.value) },
    },
  })
  return wrapper
}
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  disposePinia(pinia)
  localStorage.removeItem(APPEARANCE_STORAGE_KEY)
  client.files = originalFiles
  resetMermaidSidebarTabs()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

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

test("renders mermaid diagrams, toolbar controls, and LaTeX copy button", async () => {
  await router.push("/sessions/12")
  vi.spyOn(mermaidService, "renderMermaidDiagram")
    .mockResolvedValueOnce('<svg data-test-mermaid="ok"><g></g></svg>')
    .mockRejectedValueOnce(new Error("Parse error"))
    .mockResolvedValue('<svg data-test-mermaid="ok"><g></g></svg>')
  const openSpy = vi.spyOn(window, "open").mockReturnValue(null)
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue()
  const view = render({}, "```mermaid\ngraph TD\n  A --> B\n```\n\n```mermaid\ninvalid diagram\n```\n\n$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$")
  await flushPromises()

  expect(view.find('[data-mermaid="0"] svg[data-test-mermaid="ok"]').exists()).toBe(true)
  expect(view.get('[data-mermaid="1"] pre code').text()).toBe("invalid diagram")
  expect(view.find('[data-mermaid-action="locate-message"]').exists()).toBe(false)

  const stage = view.get('[data-mermaid="0"] [data-mermaid-stage]')
  await view.get('[data-mermaid-action="zoom-in"]').trigger("click")
  expect(stage.attributes("style")).toContain("scale(1.25)")
  await view.get('[data-mermaid-action="zoom-out"]').trigger("click")
  await view.get('[data-mermaid-action="zoom-out"]').trigger("click")
  expect(stage.attributes("style")).toContain("scale(0.75)")
  await view.get('[data-mermaid-action="reset"]').trigger("click")
  expect(stage.attributes("style")).toContain("translate(0px, 0px) scale(1)")

  await view.get('[data-mermaid-action="focus"]').trigger("click")
  await flushPromises()
  expect(router.currentRoute.value.query.mermaid).toBe("graph TD\n  A --> B")

  await view.get('[data-mermaid-action="more"]').trigger("click")
  await flushPromises()
  await view.get('[data-mermaid-action="copy"]').trigger("click")
  await flushPromises()
  expect(writeText).toHaveBeenCalledWith("graph TD\n  A --> B")

  await view.get('[data-mermaid-action="more"]').trigger("click")
  await flushPromises()
  await view.get('[data-mermaid-action="show-in-sidebar"]').trigger("click")
  expect(mermaidSidebarTabs.value).toEqual([{ id: "mermaid-1", code: "graph TD\n  A --> B", source: { sessionId: "12", diagramId: "0" } }])

  await view.get('[data-mermaid-action="more"]').trigger("click")
  await flushPromises()
  await view.get('[data-mermaid-action="show-in-new-window"]').trigger("click")
  expect(openSpy).toHaveBeenCalledOnce()
  expect(openSpy.mock.calls[0]![0]).toContain("#/mermaid?code=graph+TD%0A++A+--%3E+B&sessionId=12&diagramId=0")

  const inlineDiagram = view.get('[data-mermaid="0"]').element as HTMLElement
  const scrollIntoView = vi.fn()
  inlineDiagram.scrollIntoView = scrollIntoView
  const windowViewer = mount(MermaidViewer, {
    attachTo: document.body,
    props: { code: "graph TD\n  A --> B", mode: "window", source: { sessionId: "12", diagramId: "0" } },
    global: { plugins: [i18n, router] },
  })
  await flushPromises()
  await windowViewer.get('[data-mermaid-action="locate-message"]').trigger("click")
  await flushPromises()
  expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" })
  expect(inlineDiagram.dataset.mermaidLocated).toBe("true")
  windowViewer.unmount()

  const copyButton = view.get("[data-math-copy]")
  await copyButton.trigger("click")
  await flushPromises()
  expect(writeText).toHaveBeenCalledWith("\\int_0^1 x^2 \\, dx = \\frac{1}{3}")
  expect(copyButton.attributes("data-copied")).toBe("true")
})

test("renders Mermaid with the selected application theme and updates existing diagrams", async () => {
  const appearance = useAppearanceStore()
  appearance.settings.theme = "light"
  const renderDiagram = vi.spyOn(mermaidService, "renderMermaidDiagram")
    .mockResolvedValue('<svg data-test-mermaid="ok"><g></g></svg>')
  render({}, "```mermaid\ngraph TD\n  A --> B\n```")
  await flushPromises()
  expect(renderDiagram).toHaveBeenLastCalledWith("graph TD\n  A --> B", false)

  appearance.settings.theme = "dark"
  await flushPromises()
  expect(renderDiagram).toHaveBeenLastCalledWith("graph TD\n  A --> B", true)
  appearance.settings.theme = "light"
  await flushPromises()
  expect(renderDiagram).toHaveBeenLastCalledWith("graph TD\n  A --> B", false)
  expect(renderDiagram).toHaveBeenCalledTimes(3)
})

test("filesystem links and line references become application resources while rejecting script schemes", async () => {
  const readResource = vi.fn(() => new Promise<never>(() => {}))
  const view = render(
    { readResource },
    '![Chart](/tmp/chart.png) ![Remote](https://example.org/a.png) [Read](file:///tmp/report.md) [Code](./src/main.ts#L12) [line](main.ts:12:4) [path](/src/main.ts:12) [file](</tmp/a"b.txt>) [bad](javascript:alert(1)) [bad](data:text/html,test) [bad](javascript:12) [site](https://example.org/a)',
  )
  await flushPromises()
  const html = view.html()
  expect(html).not.toContain('src="/tmp/chart.png"')
  expect(html).toContain('src="https://example.org/a.png"')
  expect(html).toContain('data-resource-link="file:///tmp/report.md"')
  expect(html).toContain('data-resource-link="./src/main.ts#L12"')
  expect(html).toContain('data-resource-link="main.ts:12:4"')
  expect(html).toContain('data-resource-link="/src/main.ts:12"')
  expect(html).toContain('data-resource-link="/tmp/a%22b.txt"')
  expect(html).not.toContain('href="file:')
  expect(html).not.toContain('href="javascript:')
  expect(html).not.toContain('href="data:')
  expect(html).not.toContain('data-resource-link="javascript:')
  expect(html).toContain('href="https://example.org/a"')
})

test("renders LaTeX inline, display, and fenced blocks while ignoring plain currency and invalid TeX", async () => {
  const view = render(
    {},
    [
      "Inline $E = mc^2$ and \\(a^2 + b^2 = c^2\\), prices like $10 and $20, escaped \\$30.",
      "",
      "$$",
      "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
      "$$",
      "",
      "\\[",
      "\\sum_{i=1}^n i",
      "\\]",
      "",
      "```latex",
      "\\alpha + \\beta",
      "```",
      "",
      "Broken $\\invalidcommand{$ fallback.",
    ].join("\n"),
  )
  await flushPromises()
  const html = view.html()
  expect(html).toContain("data-math-inline")
  expect(html).toContain("data-math-block")
  expect(html).toContain('data-math-copy="\\int_0^1 x^2 \\, dx = \\frac{1}{3}"')
  expect(html).toContain('data-math-copy="\\alpha + \\beta"')
  expect(html).toContain('class="katex"')
  expect(html).toContain('class="katex-display"')
  expect(html).toContain("prices like $10 and $20, escaped $30.")
  expect(html).toContain('class="ui-math-fallback"')
})
