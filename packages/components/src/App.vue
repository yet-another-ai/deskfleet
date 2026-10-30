<script setup lang="ts">
import { usePlatformClient } from "./composables/usePlatformClient.ts"

import { storeToRefs } from "pinia"
import { useEventListener, whenever } from "@vueuse/core"
import { computed, onBeforeUnmount, onMounted } from "vue"
import { RouterView, useRoute } from "vue-router"
import WindowToolbar from "./components/chrome/WindowToolbar.vue"
import ChangesPanel from "./components/details/ChangesPanel.vue"
import PreviewViewer from "./components/session/PreviewViewer.vue"
import AppSidebar from "./components/sidebar/AppSidebar.vue"
import { listenMermaidLocate, locateMermaidInMainView, useLayoutStore } from "./stores/layout.ts"
import { focusedPreviewFromRoute, listenPreviewWindowMessages, locatePreviewInMainView, performPreviewLocateDom } from "./stores/previews.ts"
import { useFleetStore } from "./stores/fleet.ts"
import { useTerminalsStore } from "./stores/terminals.ts"
import { useAgentSessionsStore } from "./stores/agent-sessions.ts"
import { useProvidersStore } from "./stores/providers.ts"

const platformClient = usePlatformClient()

const { sidebarOpen, detailsOpen } = storeToRefs(useLayoutStore())
const route = useRoute()
const focusedPreview = computed(() => focusedPreviewFromRoute(route))
const fleet = useFleetStore()
const terminals = useTerminalsStore()
const agents = useAgentSessionsStore()
const providers = useProvidersStore()
whenever(() => fleet.localDesktopTarget.online, () => { void terminals.refresh() })
const refresh = () => { void fleet.refreshLocal().then(() => {
  if (fleet.localDesktopTarget.online || platformClient.agent.history) void agents.refresh()
  if (fleet.localDesktopTarget.online || platformClient.providers.display) void providers.refresh()
}) }
const unsubscribeSettings = platformClient.settings.onChanged(({ status }) => {
  if (status === "running" || status === "stopped" || status === "error") {
    refresh()
    void terminals.refresh()
  }
})
const unsubscribePreviewMessages = listenPreviewWindowMessages((content, source) => {
  window.focus()
  void locatePreviewInMainView(content, source)
})
const unsubscribeMermaidLocate = listenMermaidLocate((code, source) => {
  window.focus()
  void locateMermaidInMainView(code, source)
})
onMounted(refresh)
useEventListener(window, "focus", refresh)
onBeforeUnmount(() => {
  unsubscribeSettings()
  unsubscribePreviewMessages()
  unsubscribeMermaidLocate()
})
</script>

<template>
  <div class="flex h-full overflow-hidden">
    <AppSidebar v-if="sidebarOpen && !route.meta.fullWindow" />
    <main class="relative flex min-w-0 flex-1 flex-col">
      <RouterView />
      <div v-if="focusedPreview && route.name !== 'session'" data-preview-focus-view class="absolute inset-0 z-20 flex flex-col bg-ui-canvas" @vue:unmounted="performPreviewLocateDom()">
        <div v-if="!sidebarOpen" class="app-drag flex h-12 shrink-0 items-center border-b border-ui-border pl-20 pr-3">
          <WindowToolbar />
        </div>
        <PreviewViewer :key="focusedPreview.content" v-bind="focusedPreview" mode="focus" class="min-h-0 flex-1 rounded-none border-0" />
      </div>
    </main>
    <ChangesPanel v-if="detailsOpen && !route.meta.fullWindow && !route.meta.hideDetails" />
  </div>
</template>
