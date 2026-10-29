<script setup lang="ts">
import { usePlatformClient } from "../../composables/usePlatformClient.ts"

import { PanelRight } from "@lucide/vue"
import { storeToRefs } from "pinia"
import { useI18n } from "vue-i18n"
import { useLayoutStore } from "../../stores/layout.ts"
import IconButton from "../common/IconButton.vue"
import WindowToolbar from "./WindowToolbar.vue"

const platformClient = usePlatformClient()

defineProps<{ hideDetails?: boolean }>()
const { t } = useI18n()
const layout = useLayoutStore()
const { sidebarOpen, detailsOpen } = storeToRefs(layout)
const platform = platformClient.platform
</script>

<template>
  <!-- The main pane's title bar. It takes over the toolbar while the sidebar is hidden. -->
  <header
    class="app-drag flex h-12 shrink-0 items-center gap-2 pr-2"
    :class="[
      !sidebarOpen && platform === 'darwin' ? 'pl-20' : 'pl-3',
      (hideDetails || !detailsOpen) && 'titlebar-overlay-inset',
    ]"
  >
    <WindowToolbar v-if="!sidebarOpen" />
    <div class="min-w-0 flex-1 truncate text-sm font-medium">
      <slot />
    </div>
    <slot name="actions" />
    <IconButton
      v-if="!hideDetails"
      :icon="PanelRight"
      :label="detailsOpen ? t('toolbar.hidePanel') : t('toolbar.showPanel')"
      @click="layout.toggleDetails()"
    />
  </header>
</template>
