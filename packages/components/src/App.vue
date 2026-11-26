<script setup lang="ts">
import { usePlatformClient } from "./composables/usePlatformClient.ts"
import { provideNavigationMotion } from "./composables/useNavigationMotion.ts"
import { useAccountSession } from "./composables/useAccountSession.ts"
import { useSessionLabel } from "./composables/useSessionLabel.ts"

import { storeToRefs } from "pinia"
import { useEventListener, useTitle, whenever } from "@vueuse/core"
import { onBeforeUnmount, onMounted } from "vue"
import { useI18n } from "vue-i18n"
import { useRoute } from "vue-router"
import AppMainWindow from "./components/chrome/AppMainWindow.vue"
import BottomSheet from "./components/common/BottomSheet.vue"
import MobileWindowManager from "./components/chrome/MobileWindowManager.vue"
import WindowManager from "./components/chrome/WindowManager.vue"
import AppSidebar from "./components/sidebar/AppSidebar.vue"
import { useLayoutStore } from "./stores/layout.ts"
import { listenPreviewWindowMessages, locatePreviewInMainView, usePreviewActions } from "./stores/previews.ts"
import { useFleetStore } from "./stores/fleet.ts"
import { useTerminalsStore } from "./stores/terminals.ts"
import { useAgentSessionsStore } from "./stores/agent-sessions.ts"
import { useProvidersStore } from "./stores/providers.ts"

const platformClient = usePlatformClient()

const layout = useLayoutStore()
const { compact, sidebarOpen, standaloneSession } = storeToRefs(layout)
const { t } = useI18n()
const route = useRoute()
provideNavigationMotion()
const fleet = useFleetStore()
const terminals = useTerminalsStore()
const agents = useAgentSessionsStore()
const providers = useProvidersStore()
const account = useAccountSession()
const sessionLabel = useSessionLabel()
const defaultTitle = () => account?.site.value?.siteName ?? "DeskFleet"
useTitle(() => {
  if (route.name !== "session") return defaultTitle()
  const sessionId = String(route.params.sessionId)
  const title = agents.views[sessionId]?.snapshot?.session.title
    || agents.sessions[sessionId]?.title
    || fleet.findSession(sessionId)?.session.title
  return sessionLabel({ id: sessionId, title })
}, { restoreOnUnmount: defaultTitle })
whenever(() => fleet.localDesktopTarget.online, () => { void terminals.refresh() })
const refresh = () => { void fleet.refreshLocal({ background: true }).then(() => {
  if (fleet.localDesktopTarget.online || platformClient.agent.history) void agents.refresh(undefined, { background: true })
  if (fleet.localDesktopTarget.online || platformClient.providers.display) void providers.refresh({ background: true })
}) }
const unsubscribeSettings = platformClient.settings.onChanged(({ status }) => {
  if (status === "running" || status === "stopped" || status === "error") {
    refresh()
    void terminals.refresh()
  }
})
const { openPreviewFromAction } = usePreviewActions()
const unsubscribePreviewMessages = listenPreviewWindowMessages((content, source) => {
  window.focus()
  void locatePreviewInMainView(content, source)
}, openPreviewFromAction)
onMounted(refresh)
useEventListener(window, "focus", refresh)
onBeforeUnmount(() => {
  layout.closeCompactPanel()
  unsubscribeSettings()
  unsubscribePreviewMessages()
})
</script>

<template>
  <div class="flex h-full overflow-clip">
    <AppSidebar v-if="sidebarOpen && !compact && !route.meta.fullWindow" />
    <WindowManager v-if="!compact && route.name === 'session'" :key="String(route.params.sessionId)" :session-id="String(route.params.sessionId)" />
    <MobileWindowManager v-else-if="compact && route.name === 'session'" :key="`mobile:${route.params.sessionId}`" :session-id="String(route.params.sessionId)" />
    <AppMainWindow v-else />
    <BottomSheet v-if="compact && !route.meta.fullWindow && !standaloneSession" :open="sidebarOpen" :title="t('catalog.workspaces')" background="sidebar" @close="layout.closeCompactPanel()">
      <AppSidebar />
    </BottomSheet>
  </div>
</template>
