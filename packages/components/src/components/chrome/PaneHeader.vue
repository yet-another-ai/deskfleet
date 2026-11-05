<script setup lang="ts">
import { usePlatformClient } from "../../composables/usePlatformClient.ts"

import { storeToRefs } from "pinia"
import { useLayoutStore } from "../../stores/layout.ts"
import WindowToolbar from "./WindowToolbar.vue"

const platformClient = usePlatformClient()

const layout = useLayoutStore()
const { compact, sidebarOpen } = storeToRefs(layout)
const platform = platformClient.platform
</script>

<template>
  <!-- The main pane's title bar. It takes over the toolbar while the sidebar is hidden. -->
  <header
    class="app-drag titlebar-overlay-inset box-content flex h-12 shrink-0 items-center gap-2 pr-2 pt-[var(--safe-area-top,0px)]"
    :class="!sidebarOpen && platform === 'darwin' ? 'pl-20' : 'pl-3'"
  >
    <WindowToolbar v-if="compact || !sidebarOpen" />
    <div class="min-w-0 flex-1 truncate text-sm font-medium">
      <slot />
    </div>
    <slot name="actions" />
  </header>
</template>
