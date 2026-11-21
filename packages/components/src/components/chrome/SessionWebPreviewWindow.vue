<script setup lang="ts">
import { whenever } from "@vueuse/core"
import type { DockviewPanelApi } from "dockview-vue"
import { ref } from "vue"
import { useDockviewPanelVisible } from "../../composables/useDockviewPanelVisible.ts"
import SessionWebPreviewPanel from "../preview/SessionWebPreviewPanel.vue"

const props = defineProps<{
  sessionId: string
  panelApi: DockviewPanelApi
  initialUrl?: string | null
}>()
const emit = defineEmits<{ change: [url: string] }>()

const visible = useDockviewPanelVisible(() => props.panelApi)
const activated = ref(visible.value)
if (!activated.value) {
  whenever(visible, () => { activated.value = true }, { once: true })
}
</script>

<template>
  <SessionWebPreviewPanel
    v-if="activated"
    :session-id="sessionId"
    :initial-url="initialUrl"
    class="h-full"
    @change="emit('change', $event)"
  />
</template>
