<script setup lang="ts">
import { ArrowLeft, ArrowRight, PanelLeft } from "@lucide/vue"
import { storeToRefs } from "pinia"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { useRoute, useRouter } from "vue-router"
import { useLayoutStore } from "../../stores/layout.ts"
import UiButton from "../common/UiButton.vue"

const { t } = useI18n()
const props = withDefaults(defineProps<{ sidebar?: boolean; history?: boolean }>(), {
  sidebar: true,
  history: true,
})
const layout = useLayoutStore()
const { sidebarOpen, standaloneSession } = storeToRefs(layout)
const showSidebar = computed(() => props.sidebar && !standaloneSession.value)
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
  <div v-if="showSidebar || history" class="flex items-center gap-1">
    <UiButton
      v-if="showSidebar"
      variant="ghost"
      size="icon"
      :label="sidebarOpen ? t('toolbar.hideSidebar') : t('toolbar.showSidebar')"
      @click="layout.toggleSidebar()"
    ><PanelLeft :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
    <UiButton
      v-if="history"
      variant="ghost"
      size="icon"
      :label="t('toolbar.back')"
      :disabled="!canGoBack"
      @click="router.back()"
    ><ArrowLeft :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
    <UiButton
      v-if="history"
      variant="ghost"
      size="icon"
      :label="t('toolbar.forward')"
      :disabled="!canGoForward"
      @click="router.forward()"
    ><ArrowRight :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
  </div>
</template>
