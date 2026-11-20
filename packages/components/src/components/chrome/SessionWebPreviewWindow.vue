<script setup lang="ts">
import type { DockviewPanelApi } from "dockview-vue"
import { useDockviewPanelVisible } from "../../composables/useDockviewPanelVisible.ts"
import SessionWebPreviewPanel from "../preview/SessionWebPreviewPanel.vue"

const props = defineProps<{
  sessionId: string
  panelApi: DockviewPanelApi
  initialUrl?: string | null
}>()
const emit = defineEmits<{ change: [url: string | null] }>()
const visible = useDockviewPanelVisible(() => props.panelApi)
</script>

<template>
  <SessionWebPreviewPanel
    :session-id="sessionId"
    :active="visible"
    :initial-url="initialUrl"
    class="h-full"
    @title="panelApi.setTitle($event)"
    @change="emit('change', $event)"
  />
</template>
