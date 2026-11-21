import { getClient } from "@deskfleet/client/platform"
import { mount } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { expect, test } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { platformClientKey } from "../../composables/usePlatformClient.ts"
import { i18n } from "../../i18n/index.ts"
import SessionConversationPane from "./SessionConversationPane.vue"

test.each([["darwin", "pl-20"], ["win32", "pl-2"]] as const)("focus overlay toolbars reserve the correct title bar space on %s", async (platform, inset) => {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/sessions/:sessionId", component: SessionConversationPane }] })
  await router.push({ path: "/sessions/30", query: { mermaid: "flowchart TD; A --> B", preview: "diagram.png", previewKind: "image" } })
  const pinia = createPinia()
  const wrapper = mount(SessionConversationPane, {
    props: { readingId: "30", sessionId: "30" },
    global: {
      plugins: [pinia, router, i18n],
      provide: { [platformClientKey as symbol]: { ...getClient(), platform } },
      stubs: { MermaidViewer: true, PreviewViewer: true, ReadingSpotlight: true, WindowToolbar: true },
    },
  })
  try {
    for (const view of ["[data-mermaid-focus-view]", "[data-preview-focus-view]"]) {
      expect(wrapper.get(`${view} .app-drag`).classes()).toContain(inset)
    }
  } finally {
    wrapper.unmount()
    disposePinia(pinia)
  }
})
