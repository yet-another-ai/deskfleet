import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { registerPreviewActionsKey, type OfficePreviewKind, type PreviewToolbarAction } from "../../services/preview.ts"
import OfficePreview from "./OfficePreview.vue"

const mocks = vi.hoisted(() => {
  const load = vi.fn<(buffer: ArrayBuffer) => Promise<void>>()
  const instances: Viewer[] = []
  class Viewer {
    readonly kind: string
    readonly host: HTMLElement
    readonly options: { onError: (reason: Error) => void; [key: string]: unknown }
    load = vi.fn((buffer: ArrayBuffer) => load(buffer))
    destroy = vi.fn()
    zoomIn = vi.fn()
    zoomOut = vi.fn()
    fitWidth = vi.fn()
    constructor(kind: string, host: HTMLElement, options: { onError: (reason: Error) => void; [key: string]: unknown }) {
      this.kind = kind
      this.host = host
      this.options = options
      instances.push(this)
    }
  }
  return { load, instances, Viewer }
})

vi.mock("@silurus/ooxml/docx", () => ({
  DocxScrollViewer: class extends mocks.Viewer {
    constructor(host: HTMLElement, options: ConstructorParameters<typeof mocks.Viewer>[2]) { super("docx", host, options) }
  },
}))
vi.mock("@silurus/ooxml/pptx", () => ({
  PptxScrollViewer: class extends mocks.Viewer {
    constructor(host: HTMLElement, options: ConstructorParameters<typeof mocks.Viewer>[2]) { super("pptx", host, options) }
  },
}))
vi.mock("@silurus/ooxml/xlsx", () => ({
  XlsxViewer: class extends mocks.Viewer {
    constructor(host: HTMLElement, options: ConstructorParameters<typeof mocks.Viewer>[2]) { super("xlsx", host, options) }
  },
}))

beforeEach(() => {
  mocks.instances.length = 0
  mocks.load.mockReset().mockResolvedValue()
})

function render(kind: OfficePreviewKind = "docx", data: Uint8Array | undefined = new Uint8Array([0x50, 0x4b])) {
  const registerActions = vi.fn<(actions: PreviewToolbarAction[]) => void>()
  const view = mount(OfficePreview, {
    props: { kind, data, src: "blob:http://localhost/office", mode: "tab" },
    global: { plugins: [i18n], provide: { [registerPreviewActionsKey as symbol]: registerActions } },
    attachTo: document.body,
  })
  return { view, registerActions }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

test.each(["docx", "xlsx", "pptx"] as const)("loads %s from copied bytes and exposes the appropriate zoom controls", async kind => {
  const fetch = vi.spyOn(globalThis, "fetch")
  const bytes = new Uint8Array([9, 0x50, 0x4b, 8]).subarray(1, 3)
  const { view, registerActions } = render(kind, bytes)
  expect(view.find('[role="status"]').exists()).toBe(true)
  await flushPromises()

  expect(mocks.instances).toHaveLength(1)
  const current = mocks.instances[0]!
  expect(current.kind).toBe(kind)
  expect(current.options).toMatchObject({ useGoogleFonts: false, enableHyperlinks: false, enableMediaPlayback: false })
  const buffer = current.load.mock.calls[0]![0]
  expect(buffer).not.toBe(bytes.buffer)
  expect(new Uint8Array(buffer)).toEqual(bytes)
  expect(fetch).not.toHaveBeenCalled()
  expect(view.find('[role="status"]').exists()).toBe(false)
  const actions = registerActions.mock.calls.at(-1)![0]
  if (kind === "xlsx") expect(actions).toEqual([])
  else {
    expect(actions.map(action => action.id)).toEqual(["zoom-in", "zoom-out", "reset"])
    for (const action of actions) action.onClick()
    expect(current.zoomIn).toHaveBeenCalledOnce()
    expect(current.zoomOut).toHaveBeenCalledOnce()
    expect(current.fitWidth).toHaveBeenCalledOnce()
  }
  view.unmount()
  expect(current.destroy).toHaveBeenCalledOnce()
  expect(registerActions).toHaveBeenLastCalledWith([])
})

test("destroys the previous surface and ignores late loading results after a source changes", async () => {
  const first = deferred(), second = deferred()
  mocks.load.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
  const { view } = render()
  await flushPromises()
  const original = mocks.instances[0]!
  await view.setProps({ src: "blob:http://localhost/replacement", data: new Uint8Array([1, 2, 3]) })
  await flushPromises()
  const replacement = mocks.instances[1]!
  expect(original.destroy).toHaveBeenCalledOnce()
  expect(original.host.isConnected).toBe(false)
  expect(replacement.host.isConnected).toBe(true)

  first.resolve()
  original.options.onError(new Error("Stale page error"))
  await flushPromises()
  expect(view.find('[role="status"]').exists()).toBe(true)
  expect(view.find('[role="alert"]').exists()).toBe(false)
  second.resolve()
  await flushPromises()
  expect(view.find('[role="status"]').exists()).toBe(false)
  view.unmount()
  expect(original.destroy).toHaveBeenCalledOnce()
  expect(replacement.destroy).toHaveBeenCalledOnce()
})

test("retries a failed load with a fresh viewer and releases a pending viewer on unmount", async () => {
  const pending = deferred()
  mocks.load.mockRejectedValueOnce(new Error("Invalid Office archive")).mockImplementationOnce(() => pending.promise)
  const { view } = render("pptx")
  await flushPromises()
  const failed = mocks.instances[0]!
  expect(view.get('[role="alert"]').text()).toBe("Invalid Office archive")
  expect(failed.destroy).toHaveBeenCalledOnce()
  await view.get('[data-office-retry]').trigger("click")
  await flushPromises()
  const retrying = mocks.instances[1]!
  expect(view.find('[role="alert"]').exists()).toBe(false)
  expect(view.find('[role="status"]').exists()).toBe(true)
  view.unmount()
  expect(failed.destroy).toHaveBeenCalledOnce()
  expect(retrying.destroy).toHaveBeenCalledOnce()
  pending.reject(new Error("Late load failure"))
  await flushPromises()
  expect(retrying.destroy).toHaveBeenCalledOnce()
})

test.each(["docx", "xlsx", "pptx"] as const)("keeps rendered %s content and controls after a background error until retry", async kind => {
  const { view, registerActions } = render(kind)
  await flushPromises()
  const current = mocks.instances[0]!
  const page = document.createElement("canvas")
  current.host.appendChild(page)
  current.options.onError(new Error("A later page could not be rendered"))
  await flushPromises()

  expect(view.get('[data-office-warning] [role="alert"]').text()).toBe("A later page could not be rendered")
  expect(view.element.contains(page)).toBe(true)
  expect(current.destroy).not.toHaveBeenCalled()
  expect(view.find('[role="status"]').exists()).toBe(false)
  const actions = registerActions.mock.calls.at(-1)![0]
  expect(actions.map(action => action.id)).toEqual(kind === "xlsx" ? [] : ["zoom-in", "zoom-out", "reset"])
  if (kind !== "xlsx") {
    actions[0]!.onClick()
    expect(current.zoomIn).toHaveBeenCalledOnce()
  }

  await view.get('[data-office-retry]').trigger("click")
  await flushPromises()
  expect(current.destroy).toHaveBeenCalledOnce()
  expect(view.element.contains(page)).toBe(false)
  expect(mocks.instances).toHaveLength(2)
  expect(view.find('[data-office-warning]').exists()).toBe(false)
  view.unmount()
})

test("background errors during loading do not finish or destroy the pending load", async () => {
  const pending = deferred()
  mocks.load.mockReturnValueOnce(pending.promise)
  const { view } = render()
  await flushPromises()
  const current = mocks.instances[0]!
  current.options.onError(new Error("An optional page resource is unavailable"))
  await flushPromises()
  expect(view.find('[role="status"]').exists()).toBe(true)
  expect(current.destroy).not.toHaveBeenCalled()
  pending.resolve()
  await flushPromises()
  expect(view.get('[data-office-warning]').text()).toContain("optional page resource")
  expect(current.host.isConnected).toBe(true)
  view.unmount()
})

test("fatal load rejection preserves its error when destroy reports another error", async () => {
  const pending = deferred()
  mocks.load.mockReturnValueOnce(pending.promise)
  const { view, registerActions } = render("pptx")
  await flushPromises()
  const current = mocks.instances[0]!
  current.destroy.mockImplementation(() => current.options.onError(new Error("Cleanup callback")))
  pending.reject(new Error("Invalid Office archive"))
  await flushPromises()
  expect(current.destroy).toHaveBeenCalledOnce()
  expect(current.host.isConnected).toBe(false)
  expect(view.get('[role="alert"]').text()).toBe("Invalid Office archive")
  expect(view.find('[data-office-warning]').exists()).toBe(false)
  expect(registerActions).toHaveBeenLastCalledWith([])
  view.unmount()
  expect(current.destroy).toHaveBeenCalledOnce()
})

test("fetches a URL only when bytes are absent and reports an HTTP failure", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("missing", { status: 404 }))
    .mockResolvedValueOnce(new Response(new Uint8Array([0x50, 0x4b])))
  const { view } = render("xlsx")
  await view.setProps({ data: undefined, src: "https://example.test/report.xlsx" })
  await flushPromises()
  expect(fetch).toHaveBeenCalledWith("https://example.test/report.xlsx", { signal: expect.any(AbortSignal) })
  expect(view.get('[role="alert"]').text()).toContain("404")
  const count = mocks.instances.length
  await view.get('[data-office-retry]').trigger("click")
  await flushPromises()
  expect(mocks.instances).toHaveLength(count + 1)
  expect(view.find('[role="alert"]').exists()).toBe(false)
  view.unmount()
})

test("aborts an outstanding fetch and never creates a viewer after unmount", async () => {
  let complete!: (response: Response) => void
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(resolve => { complete = resolve }))
  const { view } = render("docx")
  await view.setProps({ data: undefined })
  await flushPromises()
  const signal = fetch.mock.calls[0]![1]!.signal!
  const count = mocks.instances.length
  view.unmount()
  expect(signal.aborted).toBe(true)
  complete(new Response(new Uint8Array([0x50, 0x4b])))
  await flushPromises()
  expect(mocks.instances).toHaveLength(count)
})
