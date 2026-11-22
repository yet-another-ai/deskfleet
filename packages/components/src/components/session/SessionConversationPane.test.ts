import { getClient } from "@deskfleet/client/platform"
import { mount } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { expect, test, vi } from "vitest"
import { nextTick } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { platformClientKey } from "../../composables/usePlatformClient.ts"
import { i18n } from "../../i18n/index.ts"
import { useConversationReadingStore } from "../../stores/conversation-reading.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import SessionConversationPane from "./SessionConversationPane.vue"

test.each([["darwin", "pl-20"], ["win32", "pl-2"]] as const)("focus overlay toolbars follow the sidebar on %s", async (platform, closedInset) => {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/sessions/:sessionId", component: SessionConversationPane }] })
  await router.push({ path: "/sessions/30", query: { mermaid: "flowchart TD; A --> B", preview: "diagram.png", previewKind: "image" } })
  const pinia = createPinia()
  const layout = useLayoutStore(pinia)
  layout.sidebarOpen = true
  const wrapper = mount(SessionConversationPane, {
    props: { readingId: "30", sessionId: "30" },
    global: {
      plugins: [pinia, router, i18n],
      provide: { [platformClientKey as symbol]: { ...getClient(), platform } },
      stubs: { MermaidViewer: true, PreviewViewer: true, ReadingSpotlight: true, WindowToolbar: true },
    },
  })
  const expectInset = (inset: string) => {
    for (const view of ["[data-mermaid-focus-view]", "[data-preview-focus-view]"]) {
      expect(wrapper.get(`${view} .app-drag`).classes()).toContain(inset)
    }
  }
  try {
    expectInset("pl-2")
    layout.sidebarOpen = false
    await nextTick()
    expectInset(closedInset)
    layout.sidebarOpen = true
    await nextTick()
    expectInset("pl-2")
    layout.standaloneSession = true
    await nextTick()
    expectInset(closedInset)
  } finally {
    wrapper.unmount()
    disposePinia(pinia)
  }
})

test("restores the saved history position when its transcript becomes available", async () => {
  const pinia = createPinia()
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: SessionConversationPane }] })
  await router.push("/")
  useConversationReadingStore(pinia).session("30").scroll = { top: 1250, bottom: false }
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(() => {})
  const wrapper = mount(SessionConversationPane, {
    props: { readingId: "30", loading: true },
    global: { plugins: [pinia, router, i18n], stubs: { ReadingSpotlight: true } },
  })
  try {
    await nextTick()
    expect(scroll).not.toHaveBeenCalledWith({ top: 1250 })
    await wrapper.setProps({ loading: false, ready: true })
    expect(scroll).toHaveBeenCalledWith({ top: 1250 })
  } finally {
    wrapper.unmount()
    disposePinia(pinia)
  }
})
