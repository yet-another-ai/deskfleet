import { flushPromises, mount } from "@vue/test-utils"
import { expect, test, vi } from "vitest"
import type { FilesApi, FileResourceRequest } from "../../../../client/src/files.ts"
import { i18n } from "../../i18n/index.ts"
import { highlighter } from "../../services/code-highlight.ts"
import AgentResourceViewer from "./AgentResourceViewer.vue"

const request: FileResourceRequest = { target: { kind: "machine", teamId: "team", machineId: "machine" }, sessionId: "session", uri: "src" }
function render(api: Partial<FilesApi>, selected = request, mode: "dialog" | "tab" = "dialog") {
  return mount(AgentResourceViewer, { props: { api: api as FilesApi, request: selected, mode }, global: { plugins: [i18n], stubs: { Teleport: { template: "<slot />" } } }, attachTo: document.body })
}

function renderText(name: string, text: string, uri = name) {
  return render({
    resolveResource: vi.fn().mockResolvedValue({ name, path: `/work/${name}`, kind: "file" }),
    readResource: vi.fn().mockResolvedValue({ name, data: new TextEncoder().encode(text), mimeType: "application/octet-stream" }),
  }, { ...request, uri })
}

test("highlights the resolved code filename with both themes and retains line navigation", async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {})
  const source = '/* multiline\n * comment */\nconst greeting: string = "你好";\n'
  const view = renderText("main.ts", source, "file:///work/alias#L2-L3")
  await flushPromises()
  expect(view.get("pre code").element.textContent).toBe(source)
  expect(view.findAll("pre code [data-line]").map(line => line.attributes("data-line"))).toEqual(["1", "2", "3"])
  const tokens = view.findAll("pre code span[style]")
  expect(tokens.length).toBeGreaterThan(3)
  const keyword = tokens.find(token => token.text() === "const")!
  const comment = tokens.find(token => token.text().includes("multiline"))!
  expect(keyword.attributes("style")).toContain("--shiki-light:")
  expect(keyword.attributes("style")).toContain("--shiki-dark:")
  expect(keyword.attributes("style")).not.toBe(comment.attributes("style"))
  expect(tokens.find(token => token.text().includes("comment */"))!.attributes("style")).toBe(comment.attributes("style"))
  expect(view.findAll("pre .bg-ui-hover").map(line => line.text())).toEqual(['* comment */', 'const greeting: string = "你好";'])
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "center" })
  expect(scroll.mock.contexts[0]).toBe(view.get("pre .bg-ui-hover").element)
  view.unmount()
})

test.each(["main.ts", "notes.txt", "unknown.custom"])("preserves literal markup and whitespace in %s", async name => {
  const source = '\tconst markup = "<img src=x onerror=alert(1)> & 文本";\r\n\r\n  // end\r\n'
  const view = renderText(name, source)
  await flushPromises()
  expect(view.get("pre code").element.textContent).toBe(source)
  expect(view.find("pre img").exists()).toBe(false)
  expect(view.find("pre code span[style]").exists()).toBe(name === "main.ts")
  view.unmount()
})

test.each(["", "\n\n", "\r\n\r\n"])("preserves empty source lines: %j", async source => {
  const view = renderText("empty.ts", source)
  await flushPromises()
  expect(view.get("pre code").element.textContent).toBe(source)
  expect(view.find('[role="alert"]').exists()).toBe(false)
  view.unmount()
})

test("keeps large source files readable without tokenizing", async () => {
  const tokenize = vi.spyOn(highlighter, "codeToTokens")
  const source = `const value = "${"x".repeat(200_000)}";`
  const view = renderText("large.ts", source)
  await flushPromises()
  expect(view.get("pre code").element.textContent).toBe(source)
  expect(tokenize).not.toHaveBeenCalled()
  view.unmount()
})

test("retains the plain text preview if syntax highlighting fails", async () => {
  vi.spyOn(highlighter, "codeToTokens").mockImplementation(() => { throw new Error("Highlight failed") })
  const source = "const value = 1;\n"
  const view = renderText("main.ts", source)
  await flushPromises()
  expect(view.get("pre code").element.textContent).toBe(source)
  expect(view.find('[role="alert"]').exists()).toBe(false)
  view.unmount()
})

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

test("shows loading progress while reading, hides download until loaded, and triggers a browser download on explicit action", async () => {
  const downloads: { href: string; filename: string }[] = []
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function(this: HTMLAnchorElement) {
    downloads.push({ href: this.href, filename: this.download })
  })
  const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:main-vue")
  const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  let finishRead!: (value: { name: string; data: Uint8Array; mimeType: string }) => void
  let reportProgress!: (progress: { transferredBytes: number; totalBytes: number }) => void
  const resolveResource = vi.fn().mockResolvedValue({ name: "main.vue", path: "/work/main.vue", kind: "file", size: 100 })
  const readResource = vi.fn((_req: FileResourceRequest, options?: { onProgress?: (progress: { transferredBytes: number; totalBytes: number }) => void }) => {
    reportProgress = progress => options?.onProgress?.(progress)
    return new Promise<{ name: string; data: Uint8Array; mimeType: string }>(resolve => { finishRead = resolve })
  })
  const saveResource = vi.fn().mockResolvedValue("job")
  const view = render({ resolveResource, readResource, saveResource })
  await flushPromises()
  expect(view.findAll("button").find(button => button.text() === "Download")).toBeUndefined()
  expect(view.get('[role="progressbar"]').attributes("aria-valuenow")).toBe("0")
  reportProgress({ transferredBytes: 45, totalBytes: 100 })
  await flushPromises()
  expect(view.get('[role="progressbar"]').attributes("aria-valuenow")).toBe("45")
  expect(view.text()).toContain("45%")

  finishRead({ name: "main.vue", data: new TextEncoder().encode("hello"), mimeType: "application/octet-stream" })
  await flushPromises()
  expect(view.find('[role="progressbar"]').exists()).toBe(false)
  expect(view.text()).toContain("hello")
  expect(downloads).toEqual([])
  await view.findAll("button").find(button => button.text() === "Download")!.trigger("click")
  expect(downloads).toEqual([{ href: "blob:main-vue", filename: "main.vue" }])
  expect(saveResource).not.toHaveBeenCalled()
  view.unmount()
  expect(revokeUrl).toHaveBeenCalledWith("blob:main-vue")
  click.mockRestore()
  createUrl.mockRestore()
  revokeUrl.mockRestore()
})

test.each(["dialog", "tab"] as const)("keeps oversized files downloadable through the scoped transfer queue in %s mode", async mode => {
  const size = 17 * 1024 * 1024
  const selected = { ...request, uri: "/work/方案.pptx" }
  const resolveResource = vi.fn().mockResolvedValue({ name: "方案.pptx", path: selected.uri, kind: "file", size })
  const readResource = vi.fn().mockRejectedValue(new Error("This file is too large to preview. Download it instead."))
  const saveResource = vi.fn().mockResolvedValue("download-job")
  const createUrl = vi.spyOn(URL, "createObjectURL")
  const view = render({ resolveResource, readResource, saveResource }, selected, mode)
  await flushPromises()

  expect(view.get('[role="alert"]').text()).toContain("too large to preview")
  expect(saveResource).not.toHaveBeenCalled()
  await view.get('[data-preview-action="download"]').trigger("click")
  await flushPromises()
  expect(saveResource).toHaveBeenCalledExactlyOnceWith(selected)
  expect(createUrl).not.toHaveBeenCalled()
  expect(view.get('[role="alert"]').text()).toContain("too large to preview")
  view.unmount()
})

test("shows a download authorization failure after a file resolved without bypassing the file API", async () => {
  const resolveResource = vi.fn().mockResolvedValue({ name: "report.pptx", path: "/work/report.pptx", kind: "file", size: 17 * 1024 * 1024 })
  const readResource = vi.fn().mockRejectedValue(new Error("This file is too large to preview. Download it instead."))
  const saveResource = vi.fn().mockRejectedValue(new Error("File access has expired"))
  const createUrl = vi.spyOn(URL, "createObjectURL")
  const view = render({ resolveResource, readResource, saveResource }, request, "tab")
  await flushPromises()
  await view.get('[data-preview-action="download"]').trigger("click")
  await flushPromises()

  expect(saveResource).toHaveBeenCalledExactlyOnceWith(request)
  expect(view.get('[role="alert"]').text()).toBe("File access has expired")
  expect(createUrl).not.toHaveBeenCalled()
  view.unmount()
})

test("downloads loaded binary files even when their preview format is unsupported", async () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:archive")
  const saveResource = vi.fn()
  const view = render({
    resolveResource: vi.fn().mockResolvedValue({ name: "archive.zip", path: "/work/archive.zip", kind: "file" }),
    readResource: vi.fn().mockResolvedValue({ name: "archive.zip", data: new Uint8Array([0x50, 0x4b, 0, 0]), mimeType: "application/octet-stream" }),
    saveResource,
  })
  await flushPromises()

  expect(view.find('[role="alert"]').exists()).toBe(true)
  await view.get('[data-preview-action="download"]').trigger("click")
  expect(click).toHaveBeenCalledOnce()
  expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe("archive.zip")
  expect((click.mock.contexts[0] as HTMLAnchorElement).href).toBe("blob:archive")
  expect(saveResource).not.toHaveBeenCalled()
  view.unmount()
})

test.each(["dialog", "tab"] as const)("opens local unsupported files instead of downloading in %s mode", async mode => {
  const openResource = vi.fn().mockRejectedValue(new Error("No application is associated with this file"))
  const saveResource = vi.fn()
  const createUrl = vi.spyOn(URL, "createObjectURL")
  const view = render({
    resolveResource: vi.fn().mockResolvedValue({ name: "archive.zip", path: "/work/archive.zip", kind: "file", canOpen: true }),
    readResource: vi.fn().mockResolvedValue({ name: "archive.zip", data: new Uint8Array([0x50, 0x4b, 0, 0]), mimeType: "application/zip", canOpen: true }),
    openResource, saveResource,
  }, request, mode)
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toContain("open it in another application")
  expect(view.find('[data-preview-action="download"]').exists()).toBe(false)
  await view.get('[data-preview-action="open"]').trigger("click")
  await flushPromises()
  expect(openResource).toHaveBeenCalledExactlyOnceWith(request)
  expect(saveResource).not.toHaveBeenCalled()
  expect(createUrl).not.toHaveBeenCalled()
  expect(view.get('[role="alert"]').text()).toBe("No application is associated with this file")
  view.unmount()
})

test.each(["dialog", "tab"] as const)("shows resolution errors without offering a download in %s mode", async mode => {
  const saveResource = vi.fn()
  const view = render({ resolveResource: vi.fn().mockRejectedValue(new Error("File path is outside the authorized folder")), saveResource }, request, mode)
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toContain("File path is outside the authorized folder")
  expect(view.find('[data-preview-action="download"]').exists()).toBe(false)
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
  expect(readResource).toHaveBeenCalledWith(selected, { onProgress: expect.any(Function) })
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

test("renders media, line-highlighted code, and workspace authorization errors inside a preview tab", async () => {
  const downloads: { href: string; filename: string }[] = []
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function(this: HTMLAnchorElement) {
    downloads.push({ href: this.href, filename: this.download })
  })
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:clip")
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  const resolveResource = vi.fn().mockResolvedValue({ name: "clip.mp4", path: "/work/clip.mp4", kind: "file" })
  const readResource = vi.fn().mockResolvedValue({ name: "clip.mp4", data: new Uint8Array([1, 2, 3]), mimeType: "video/mp4" })
  const saveResource = vi.fn()
  const mediaView = mount(AgentResourceViewer, {
    props: { api: { resolveResource, readResource, saveResource } as unknown as FilesApi, request: { ...request, uri: "file:///work/clip.mp4" }, mode: "tab" },
    global: { plugins: [i18n], stubs: { Teleport: { template: "<slot />" } } },
    attachTo: document.body,
  })
  await flushPromises()
  expect(mediaView.find('[data-resource-viewer-mode="tab"]').exists()).toBe(true)
  expect(mediaView.get("video").attributes("src")).toBe("blob:clip")
  expect(mediaView.find("pre code").exists()).toBe(false)
  expect(create).toHaveBeenCalledOnce()
  await mediaView.get('[data-preview-action="more"]').trigger("click")
  await flushPromises()
  await mediaView.get('[data-preview-action="download"]').trigger("click")
  expect(downloads).toEqual([{ href: "blob:clip", filename: "clip.mp4" }])
  expect(saveResource).not.toHaveBeenCalled()
  mediaView.unmount()
  expect(revoke).toHaveBeenCalledWith("blob:clip")
  click.mockRestore()

  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {})
  const codeView = mount(AgentResourceViewer, {
    props: {
      api: {
        resolveResource: vi.fn().mockResolvedValue({ name: "deskfleet.svg", path: "/work/deskfleet.svg", kind: "file" }),
        readResource: vi.fn().mockResolvedValue({ name: "deskfleet.svg", data: new TextEncoder().encode("<svg>\n  <path />\n</svg>"), mimeType: "image/svg+xml" }),
      } as unknown as FilesApi,
      request: { ...request, uri: "./deskfleet.svg#L2-L2" },
      mode: "tab",
    },
    global: { plugins: [i18n], stubs: { Teleport: { template: "<slot />" } } },
    attachTo: document.body,
  })
  await flushPromises()
  expect(codeView.findAll("pre .bg-ui-hover").map(line => line.text())).toEqual(["<path />"])
  expect(codeView.findAll("pre code [data-line]").map(line => line.attributes("data-line"))).toEqual(["1", "2", "3"])
  expect(scroll).toHaveBeenCalledWith({ block: "center" })
  expect(codeView.find('[data-preview-action="download"]').exists()).toBe(true)
  codeView.unmount()

  const deniedView = mount(AgentResourceViewer, {
    props: {
      api: {
        resolveResource: vi.fn().mockRejectedValue(new Error("File path is outside the authorized folder")),
      } as unknown as FilesApi,
      request: { ...request, uri: "file:///etc/passwd" },
      mode: "tab",
    },
    global: { plugins: [i18n], stubs: { Teleport: { template: "<slot />" } } },
    attachTo: document.body,
  })
  await flushPromises()
  expect(deniedView.get('[role="alert"]').text()).toContain("File path is outside the authorized folder")
  expect(deniedView.find('[data-preview-action="download"]').exists()).toBe(false)
  deniedView.unmount()
})

test.each([
  ["index.html", "tab"],
  ["report.htm", "dialog"],
] as const)("defaults %s to highlighted source and toggles into a sandboxed HTML preview (%s mode)", async (name, mode) => {
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {})
  const html = "<!doctype html>\n<html>\n<body><h1>Hello</h1></body>\n</html>"
  const view = render({
    resolveResource: vi.fn().mockResolvedValue({ name, path: `/work/${name}`, kind: "file" }),
    readResource: vi.fn().mockResolvedValue({ name, data: new TextEncoder().encode(html), mimeType: "text/html" }),
  }, { ...request, uri: `${name}#L3` }, mode)
  await flushPromises()

  expect(view.get("pre code").element.textContent).toBe(html)
  expect(view.find("pre code span[style]").exists()).toBe(true)
  expect(view.find("iframe[data-html-preview]").exists()).toBe(false)
  expect(scroll).toHaveBeenCalledTimes(1)

  await view.get('[data-preview-action="preview-html"]').trigger("click")
  await flushPromises()

  expect(view.find("pre code").exists()).toBe(false)
  const frame = view.get("iframe[data-html-preview]")
  expect(frame.attributes("src")).toBe("./html-preview.html")
  expect(frame.attributes("srcdoc")).toBeUndefined()
  expect(frame.attributes("sandbox")).toBe("allow-scripts allow-forms")
  expect(frame.attributes("sandbox")).not.toContain("allow-same-origin")

  const postMessage = vi.fn()
  Object.defineProperty(frame.element, "contentWindow", { value: { postMessage }, configurable: true })
  await frame.trigger("load")
  await frame.trigger("load")
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({ html }, "*")

  await view.get('[data-preview-action="source"]').trigger("click")
  await flushPromises()

  expect(view.find("iframe[data-html-preview]").exists()).toBe(false)
  expect(view.get("pre code").element.textContent).toBe(html)
  expect(scroll).toHaveBeenCalledTimes(2)
  view.unmount()
})


