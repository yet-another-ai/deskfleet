<script setup lang="ts">
import { usePlatformClient } from "./composables/usePlatformClient.ts"

import { storeToRefs } from "pinia"
import { useEventListener, whenever } from "@vueuse/core"
import { onBeforeUnmount, onMounted } from "vue"
import { useI18n } from "vue-i18n"
import { useRoute } from "vue-router"
import AppMainWindow from "./components/chrome/AppMainWindow.vue"
import CompactPanel from "./components/chrome/CompactPanel.vue"
import WindowManager from "./components/chrome/WindowManager.vue"
import ChangesPanel from "./components/details/ChangesPanel.vue"
import AppSidebar from "./components/sidebar/AppSidebar.vue"
import { listenMermaidLocate, locateMermaidInMainView, useLayoutStore } from "./stores/layout.ts"
import { listenPreviewWindowMessages, locatePreviewInMainView } from "./stores/previews.ts"
import { useFleetStore } from "./stores/fleet.ts"
import { useTerminalsStore } from "./stores/terminals.ts"
import { useAgentSessionsStore } from "./stores/agent-sessions.ts"
import { useProvidersStore } from "./stores/providers.ts"

const platformClient = usePlatformClient()

const layout = useLayoutStore()
const { compact, sidebarOpen, detailsOpen } = storeToRefs(layout)
const { t } = useI18n()
const route = useRoute()
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
  layout.closeCompactPanel()
  unsubscribeSettings()
  unsubscribePreviewMessages()
  unsubscribeMermaidLocate()
})
</script>

<template>
  <div class="flex h-full overflow-hidden">
    <AppSidebar v-if="sidebarOpen && !compact && !route.meta.fullWindow" />
    <WindowManager v-if="!compact && route.name === 'session'" :key="String(route.params.sessionId)" :session-id="String(route.params.sessionId)" />
    <AppMainWindow v-else />
    <CompactPanel v-if="compact && sidebarOpen && !route.meta.fullWindow" side="left" :title="t('catalog.workspaces')" @close="layout.closeCompactPanel()">
      <AppSidebar class="h-full" />
    </CompactPanel>
    <CompactPanel v-if="compact && detailsOpen && route.name === 'session'" side="right" :title="t('panel.changes')" @close="layout.closeCompactPanel()">
      <ChangesPanel class="h-full" />
    </CompactPanel>
  </div>
</template>
