import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { defineComponent, h } from "vue"
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import * as mermaidService from "../../services/mermaid.ts"
import { previewKindFromMime, previewKindFromUri, resolvePreviewKind } from "../../services/preview.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import PreviewViewer from "./PreviewViewer.vue"

let wrapper: VueWrapper | undefined
const stores: ReturnType<typeof createPinia>[] = []
beforeAll(async () => { await import("../../views/SessionView.vue") })
afterEach(async () => {
  wrapper?.unmount()
  wrapper = undefined
  for (const pinia of stores.splice(0)) disposePinia(pinia)
  await router.replace("/")
  localStorage.clear()
  vi.restoreAllMocks()
})

test.each([
  { kind: "mermaid", compact: true },
  { kind: "image", compact: true },
  { kind: "mermaid", compact: false },
  { kind: "image", compact: false },
] as const)("locating $kind in the current Session closes only the compact drawer (compact=$compact)", async ({ kind, compact }) => {
  localStorage.clear()
  vi.spyOn(window, "matchMedia").mockImplementation(query => Object.assign(new EventTarget(), {
    matches: query.includes("max-width") && compact,
    media: query,
  }) as MediaQueryList)
  vi.spyOn(mermaidService, "renderMermaidDiagram").mockResolvedValue("<svg></svg>")
  await router.push("/sessions/30")
  const navigate = vi.spyOn(router, "push")
  const content = kind === "mermaid" ? "graph TD; A --> B" : "data:image/png;base64,AA=="
  const entry = document.createElement("div")
  entry.dataset.conversationEntry = "message-7"
  const original = document.createElement("div")
  original.dataset[kind === "mermaid" ? "mermaid" : "preview"] = "0"
  original.dataset[kind === "mermaid" ? "mermaidMode" : "previewMode"] = "inline"
  original.dataset[kind === "mermaid" ? "mermaidCode" : "previewContent"] = content
  const scroll = vi.fn()
  original.scrollIntoView = scroll
  entry.appendChild(original)
  document.body.appendChild(entry)

  const pinia = createPinia()
  stores.push(pinia)
  const Harness = defineComponent({
    setup() {
      const layout = useLayoutStore()
      return () => (!compact || layout.detailsOpen) ? h(PreviewViewer, {
        kind, content, mode: "tab", source: { sessionId: "30", entryId: "message-7", itemId: "0" },
      }) : null
    },
  })
  wrapper = mount(Harness, {
    attachTo: document.body,
    global: { plugins: [pinia, i18n, router], stubs: { Teleport: { inheritAttrs: false, template: "<slot />" } } },
  })
  await flushPromises()
  const layout = useLayoutStore(pinia)
  if (compact) layout.toggleDetails()
  await flushPromises()

  // Another retained machine may become the active Pinia before the click.
  const otherPinia = createPinia()
  stores.push(otherPinia)
  const otherLayout = useLayoutStore(otherPinia)
  if (compact) otherLayout.toggleDetails()
  setActivePinia(otherPinia)
  if (kind === "image") {
    await wrapper.get('[data-preview-action="more"]').trigger("click")
    await flushPromises()
  }
  await wrapper.get(`[data-${kind === "mermaid" ? "mermaid" : "preview"}-action="locate-message"]`).trigger("click")
  await flushPromises()
  expect(navigate).not.toHaveBeenCalled()
  expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "center" })
  expect(layout.detailsOpen).toBe(false)
  expect(wrapper.find(`[data-${kind === "mermaid" ? "mermaid" : "preview"}-mode="tab"]`).exists()).toBe(!compact)
  expect(otherLayout.detailsOpen).toBe(compact)
})

test("ImagePreview registers toolbar actions and handles zoom/reset gestures, while audio and 3D models resolve their preview kinds", async () => {
  expect(previewKindFromMime("model/gltf-binary")).toBe("model")
  expect(previewKindFromUri("/workspace/part.stl")).toBe("model")
  expect(previewKindFromUri("/workspace/scene.glb")).toBe("model")
  expect(resolvePreviewKind("file:///workspace/mesh.obj")).toBe("model")
  expect(resolvePreviewKind("blob:http://localhost/1", "model")).toBe("model")

  const pinia = createPinia()
  stores.push(pinia)
  wrapper = mount(PreviewViewer, {
    attachTo: document.body,
    props: { kind: "image", content: "data:image/png;base64,AA==", mode: "inline" },
    global: {
      plugins: [pinia, i18n, router],
      stubs: {
        Teleport: { inheritAttrs: false, template: "<slot />" },
        TresCanvas: { template: '<div data-tres-canvas><slot /></div>' },
        OrbitControls: true,
      },
    },
  })
  await flushPromises()
  const stage = wrapper.get("[data-preview-stage]")
  await wrapper.get('[data-preview-action="zoom-in"]').trigger("click")
  expect(stage.attributes("style")).toContain("scale(1.25)")
  await wrapper.get('[data-preview-action="reset"]').trigger("click")
  expect(stage.attributes("style")).toContain("translate(0px, 0px) scale(1)")
  expect(wrapper.find('[data-preview-action="color-picker"]').exists()).toBe(true)

  await wrapper.setProps({ kind: "audio", content: "data:audio/wav;base64,AA==" })
  await flushPromises()
  expect(wrapper.find('[data-preview-action="zoom-in"]').exists()).toBe(false)
  expect(wrapper.find('[data-preview-action="color-picker"]').exists()).toBe(false)
  expect(wrapper.find("audio").exists()).toBe(true)

  const asciiStl = btoa("solid s\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid s")
  await wrapper.setProps({
    kind: "model",
    content: `data:model/stl;base64,${asciiStl}`,
    mimeType: "model/stl",
    title: "triangle.stl",
  })
  // ModelPreview lazily imports Tres/Three and their loaders; await that work
  // before asserting the mounted preview instead of timing cold imports.
  await vi.dynamicImportSettled()
  await flushPromises()
  expect(wrapper.find("[data-tres-canvas]").exists()).toBe(true)
  expect(wrapper.find('[data-preview-action="zoom-in"]').exists()).toBe(true)
  expect(wrapper.find('[data-preview-action="color-picker"]').exists()).toBe(false)
  expect(wrapper.attributes("data-preview-kind")).toBe("model")
})

test("picks colors from image and video previews, pins loupe on click, copies HEX, and closes on outside click", async () => {
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue()
  const drawImage = vi.fn()
  const getImageData = vi.fn((x: number, y: number, w: number, h: number) => {
    const data = new Uint8ClampedArray(w * h * 4)
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const i = (row * w + col) * 4
        data[i] = ((x + col) * 10) & 0xff
        data[i + 1] = ((y + row) * 20) & 0xff
        data[i + 2] = 0xf6
        data[i + 3] = 255
      }
    }
    return { data } as ImageData
  })
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
    clearRect: vi.fn(),
    drawImage,
    getImageData,
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext)

  const pinia = createPinia()
  stores.push(pinia)
  await router.push("/sessions/30")
  wrapper = mount(PreviewViewer, {
    attachTo: document.body,
    props: { kind: "image", content: "data:image/png;base64,AA==", mode: "inline" },
    global: { plugins: [pinia, i18n, router], stubs: { Teleport: { inheritAttrs: false, template: "<slot />" } } },
  })
  await flushPromises()

  const img = wrapper.get("img").element as HTMLImageElement
  Object.defineProperties(img, { naturalWidth: { value: 100, configurable: true }, naturalHeight: { value: 50, configurable: true } })
  vi.spyOn(img, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 200, 100))

  await wrapper.get('[data-preview-action="color-picker"]').trigger("click")
  await wrapper.get("[data-preview-canvas]").trigger("pointermove", { clientX: 50, clientY: 40 })
  expect(wrapper.get("[data-color-picker-loupe]").attributes("data-color-picker-hex")).toBe("#C8C8F6")
  expect(wrapper.findAll("[data-color-picker-grid] > span")).toHaveLength(49)

  await wrapper.get("img").trigger("click", { clientX: 70, clientY: 60 })
  expect(wrapper.get("[data-color-picker-loupe]").attributes("data-pinned")).toBe("true")
  expect(wrapper.get("[data-color-picker-loupe]").attributes("data-color-picker-hex")).toBe("#2C90F6")
  await wrapper.get("[data-preview-canvas]").trigger("pointermove", { clientX: 50, clientY: 40 })
  expect(wrapper.get("[data-color-picker-loupe]").attributes("data-color-picker-hex")).toBe("#2C90F6")

  await wrapper.get("[data-color-picker-copy]").trigger("click")
  await flushPromises()
  expect(writeText).toHaveBeenCalledWith("#2C90F6")
  expect(wrapper.get("[data-color-picker-copy]").attributes("data-copied")).toBe("true")

  await wrapper.get("[data-preview-canvas]").trigger("click", { clientX: 90, clientY: 70 })
  expect(wrapper.find("[data-color-picker-loupe]").exists()).toBe(false)
  expect(router.currentRoute.value.query.preview).toBeUndefined()

  await wrapper.setProps({ kind: "video", content: "blob:http://localhost/clip.mp4" })
  await flushPromises()
  const video = wrapper.get("video").element as HTMLVideoElement
  Object.defineProperties(video, { videoWidth: { value: 80, configurable: true }, videoHeight: { value: 40, configurable: true } })
  vi.spyOn(video, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 160, 80))

  await wrapper.get('[data-preview-action="color-picker"]').trigger("click")
  await wrapper.get("[data-preview-canvas]").trigger("click", { clientX: 20, clientY: 10 })
  expect(drawImage).toHaveBeenLastCalledWith(video, 0, 0, 80, 40)
  expect(wrapper.get("[data-color-picker-loupe]").attributes("data-color-picker-hex")).toBe("#6464F6")
})
