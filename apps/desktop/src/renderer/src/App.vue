<script setup lang="ts">
import { storeToRefs } from "pinia"
import { onBeforeUnmount, onMounted, watch } from "vue"
import { RouterView, useRoute } from "vue-router"
import DetailsPanel from "./components/details/DetailsPanel.vue"
import AppSidebar from "./components/sidebar/AppSidebar.vue"
import { useLayoutStore } from "./stores/layout.ts"
import { useFleetStore } from "./stores/fleet.ts"
import { useTerminalsStore } from "./stores/terminals.ts"
import { useAgentSessionsStore } from "./stores/agent-sessions.ts"

const { sidebarOpen, detailsOpen } = storeToRefs(useLayoutStore())
const route = useRoute()
const fleet = useFleetStore()
const terminals = useTerminalsStore()
const agents = useAgentSessionsStore()
watch(() => fleet.localDesktopTarget.online, (online) => { if (online) void terminals.refresh() })
const refresh = () => { void fleet.refreshLocal().then(() => { if (fleet.localDesktopTarget.online) void agents.refresh() }) }
const unsubscribeSettings = window.deskfleet.settings.onChanged(({ status }) => {
  if (status === "running" || status === "stopped" || status === "error") {
    refresh()
    void terminals.refresh()
  }
})
onMounted(() => { refresh(); window.addEventListener("focus", refresh) })
onBeforeUnmount(() => {
  window.removeEventListener("focus", refresh)
  unsubscribeSettings()
})
</script>

<template>
  <div class="flex h-full overflow-hidden">
    <AppSidebar v-if="sidebarOpen && !route.meta.fullWindow" />
    <main class="flex min-w-0 flex-1 flex-col">
      <RouterView />
    </main>
    <DetailsPanel v-if="detailsOpen && !route.meta.fullWindow" />
  </div>
</template>
