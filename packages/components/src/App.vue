<script setup lang="ts">
import { client as platformClient } from "@deskfleet/client/platform"

import { storeToRefs } from "pinia"
import { useEventListener, whenever } from "@vueuse/core"
import { onBeforeUnmount, onMounted } from "vue"
import { RouterView, useRoute } from "vue-router"
import ChangesPanel from "./components/details/ChangesPanel.vue"
import AppSidebar from "./components/sidebar/AppSidebar.vue"
import { useLayoutStore } from "./stores/layout.ts"
import { useFleetStore } from "./stores/fleet.ts"
import { useTerminalsStore } from "./stores/terminals.ts"
import { useAgentSessionsStore } from "./stores/agent-sessions.ts"
import { useProvidersStore } from "./stores/providers.ts"

const { sidebarOpen, detailsOpen } = storeToRefs(useLayoutStore())
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
onMounted(refresh)
useEventListener(window, "focus", refresh)
onBeforeUnmount(unsubscribeSettings)
</script>

<template>
  <div class="flex h-full overflow-hidden">
    <AppSidebar v-if="sidebarOpen && !route.meta.fullWindow" />
    <main class="flex min-w-0 flex-1 flex-col">
      <RouterView />
    </main>
    <ChangesPanel v-if="detailsOpen && !route.meta.fullWindow && !route.meta.hideDetails" />
  </div>
</template>
