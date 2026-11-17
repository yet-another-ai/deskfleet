<script setup lang="ts">
import type { DockviewPanelApi } from "dockview-vue"
import { ref, watch } from "vue"
import type { WebPreviewTarget } from "../../services/web-preview.ts"
import SessionWebPreviewPanel from "../preview/SessionWebPreviewPanel.vue"

const props = defineProps<{
  sessionId: string
  panelApi: DockviewPanelApi
  initialTarget?: WebPreviewTarget | null
}>()
const emit = defineEmits<{ change: [target: WebPreviewTarget | null] }>()
const visible = ref(false)

watch(() => props.panelApi, (api, _previous, cleanup) => {
  const update = () => { visible.value = api.isVisible && api.group.api.isVisible }
  let groupVisibility: { dispose(): void } | undefined
  const observeGroup = () => {
    groupVisibility?.dispose()
    groupVisibility = api.group.api.onDidVisibilityChange(update)
    update()
  }
  const subscription = api.onDidVisibilityChange(update)
  const groupChange = api.onDidGroupChange(observeGroup)
  observeGroup()
  cleanup(() => { subscription.dispose(); groupChange.dispose(); groupVisibility?.dispose() })
}, { immediate: true })
</script>

<template>
  <SessionWebPreviewPanel
    :session-id="sessionId"
    :active="visible"
    :initial-target="initialTarget"
    class="h-full"
    @title="panelApi.setTitle($event)"
    @change="emit('change', $event)"
  />
</template>
