<script setup lang="ts">
import { ArrowLeft, ArrowRight, PanelLeft } from "@lucide/vue"
import { storeToRefs } from "pinia"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { useRoute, useRouter } from "vue-router"
import { useLayoutStore } from "../../stores/layout.ts"
import IconButton from "../common/IconButton.vue"

const { t } = useI18n()
withDefaults(defineProps<{ sidebar?: boolean; history?: boolean }>(), {
  sidebar: true,
  history: true,
})
const layout = useLayoutStore()
const { sidebarOpen } = storeToRefs(layout)
const router = useRouter()
const route = useRoute()

// vue-router records the neighbouring history entries in history.state.
function historyEntry(direction: "back" | "forward"): boolean {
  void route.fullPath
  const state = window.history.state as Partial<Record<typeof direction, string | null>> | null
  return state?.[direction] != null
}
const canGoBack = computed(() => historyEntry("back"))
const canGoForward = computed(() => historyEntry("forward"))
</script>

<template>
  <div class="flex items-center gap-1">
    <IconButton
      v-if="sidebar"
      :icon="PanelLeft"
      :label="sidebarOpen ? t('toolbar.hideSidebar') : t('toolbar.showSidebar')"
      @click="layout.toggleSidebar()"
    />
    <IconButton
      v-if="history"
      :icon="ArrowLeft"
      :label="t('toolbar.back')"
      :disabled="!canGoBack"
      @click="router.back()"
    />
    <IconButton
      v-if="history"
      :icon="ArrowRight"
      :label="t('toolbar.forward')"
      :disabled="!canGoForward"
      @click="router.forward()"
    />
  </div>
</template>
