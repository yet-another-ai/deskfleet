<script setup lang="ts">
import type { DockviewPanelApi } from "dockview-vue"
import { ref, watch } from "vue"
import SessionDesktopPanel from "../desktop/SessionDesktopPanel.vue"

const props = defineProps<{ sessionId: string; panelApi: DockviewPanelApi }>()
const visible = ref(false)
// Dockview visibility follows the selected tab and its group's visibility;
// focusing Chat in a neighboring group does not hide the desktop previews.
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
  <SessionDesktopPanel :session-id="sessionId" :active="visible" class="h-full" />
</template>
