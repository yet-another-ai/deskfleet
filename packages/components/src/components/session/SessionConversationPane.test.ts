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
  await router.push({ path: "/sessions/30", query: { preview: "diagram.png", previewKind: "image" } })
  const pinia = createPinia()
  const layout = useLayoutStore(pinia)
  layout.sidebarOpen = true
  const wrapper = mount(SessionConversationPane, {
    props: { readingId: "30", sessionId: "30" },
    global: {
      plugins: [pinia, router, i18n],
      provide: { [platformClientKey as symbol]: { ...getClient(), platform } },
      stubs: { PreviewViewer: true, ReadingSpotlight: true, WindowToolbar: true },
    },
  })
  const expectInset = (inset: string) => {
    expect(wrapper.get("[data-preview-focus-view] .app-drag").classes()).toContain(inset)
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

test("a small scroll away from the bottom keeps its position through a transcript resize and new revision", async () => {
  let resizeTranscript!: () => void
  const NativeResizeObserver = window.ResizeObserver
  vi.spyOn(window, "ResizeObserver").mockImplementation(class extends NativeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      super(callback)
      this.observe = element => {
        if (element.firstElementChild?.hasAttribute("data-transcript-fixture")) {
          resizeTranscript = () => callback([], this)
        }
      }
    }
  })
  const pinia = createPinia()
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: SessionConversationPane }] })
  await router.push("/")
  const wrapper = mount(SessionConversationPane, {
    props: { readingId: "30", ready: true },
    slots: { default: "<div data-transcript-fixture />" },
    global: { plugins: [pinia, router, i18n], stubs: { ReadingSpotlight: true } },
  })
  try {
    await nextTick()
    const viewport = wrapper.get<HTMLElement>("[data-session-scroll-viewport]")
    let height = 1600
    Object.defineProperties(viewport.element, {
      scrollHeight: { get: () => height },
      clientHeight: { value: 400 },
      scrollTop: { value: 1200, writable: true },
    })
    const scroll = vi.spyOn(viewport.element, "scrollTo").mockImplementation(() => {})
    await viewport.trigger("scroll")
    viewport.element.scrollTop -= 12
    await viewport.trigger("scroll")
    height += 300
    resizeTranscript()
    await wrapper.setProps({ revision: 1 })
    expect(scroll).not.toHaveBeenCalled()
    expect(wrapper.find("[data-scroll-to-bottom]").exists()).toBe(true)

    viewport.element.scrollTop = height - viewport.element.clientHeight
    await viewport.trigger("scroll")
    height += 100
    resizeTranscript()
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: height })
  } finally {
    wrapper.unmount()
    disposePinia(pinia)
  }
})
