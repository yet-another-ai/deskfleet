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

  await wrapper.setProps({ kind: "audio", content: "data:audio/wav;base64,AA==" })
  await flushPromises()
  expect(wrapper.find('[data-preview-action="zoom-in"]').exists()).toBe(false)
  expect(wrapper.find("audio").exists()).toBe(true)

  const asciiStl = btoa("solid s\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid s")
  await wrapper.setProps({
    kind: "model",
    content: `data:model/stl;base64,${asciiStl}`,
    mimeType: "model/stl",
    title: "triangle.stl",
  })
  await flushPromises()
  await vi.waitFor(() => expect(wrapper!.find("[data-tres-canvas]").exists()).toBe(true))
  expect(wrapper.find('[data-preview-action="zoom-in"]').exists()).toBe(true)
  expect(wrapper.attributes("data-preview-kind")).toBe("model")
})
