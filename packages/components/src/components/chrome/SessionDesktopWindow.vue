<script setup lang="ts">
import type { DockviewPanelApi } from "dockview-vue"
import { useDockviewPanelVisible } from "../../composables/useDockviewPanelVisible.ts"
import SessionDesktopPanel from "../desktop/SessionDesktopPanel.vue"

const props = defineProps<{ sessionId: string; panelApi: DockviewPanelApi }>()
// Focusing Chat in a neighboring group keeps visible desktop previews active.
const visible = useDockviewPanelVisible(() => props.panelApi)
</script>

<template>
  <SessionDesktopPanel :session-id="sessionId" :active="visible" class="h-full" />
</template>
