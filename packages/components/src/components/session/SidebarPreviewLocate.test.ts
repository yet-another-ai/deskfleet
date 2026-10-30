import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { defineComponent, h } from "vue"
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import * as mermaidService from "../../services/mermaid.ts"
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
      return () => layout.detailsOpen ? h(PreviewViewer, {
        kind, content, mode: "sidebar", source: { sessionId: "30", entryId: "message-7", itemId: "0" },
      }) : null
    },
  })
  wrapper = mount(Harness, {
    attachTo: document.body,
    global: { plugins: [pinia, i18n, router], stubs: { Teleport: { inheritAttrs: false, template: "<slot />" } } },
  })
  await flushPromises()
  const layout = useLayoutStore(pinia)
  layout.detailsOpen = true
  await flushPromises()

  // Another retained machine may become the active Pinia before the click.
  const otherPinia = createPinia()
  stores.push(otherPinia)
  const otherLayout = useLayoutStore(otherPinia)
  otherLayout.detailsOpen = true
  setActivePinia(otherPinia)
  if (kind === "image") {
    await wrapper.get('[data-preview-action="more"]').trigger("click")
    await flushPromises()
  }
  await wrapper.get(`[data-${kind === "mermaid" ? "mermaid" : "preview"}-action="locate-message"]`).trigger("click")
  await flushPromises()
  expect(navigate).not.toHaveBeenCalled()
  expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "center" })
  expect(layout.detailsOpen).toBe(!compact)
  expect(wrapper.find(`[data-${kind === "mermaid" ? "mermaid" : "preview"}-mode="sidebar"]`).exists()).toBe(!compact)
  expect(otherLayout.detailsOpen).toBe(true)
  expect(localStorage.getItem("deskfleet.details-open")).toBe("true")
})
