<script setup lang="ts">
import { computed, provide } from "vue"
import { RouterView, useRoute } from "vue-router"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import { focusedPreviewFromRoute, performPreviewLocateDom } from "../../stores/previews.ts"
import PreviewViewer from "../session/PreviewViewer.vue"
import FocusOverlay from "../common/FocusOverlay.vue"
import WindowToolbar from "./WindowToolbar.vue"
import { windowHeaderActionsTargetKey } from "./windowHeaderActions.ts"

const props = defineProps<{ windowed?: boolean; windowHeaderActionsTarget?: string }>()
const platform = usePlatformClient().platform
const layout = useLayoutStore()
const route = useRoute()
const focusedPreview = computed(() => focusedPreviewFromRoute(route))
if (props.windowed) provide(windowHeaderActionsTargetKey, computed(() => props.windowHeaderActionsTarget))
</script>

<template>
  <main class="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-ui-canvas">
    <RouterView />
    <FocusOverlay :content="route.name !== 'session' ? focusedPreview : undefined" data-preview-focus-view class="absolute inset-0 z-20 flex flex-col bg-ui-canvas" @after-leave="performPreviewLocateDom()" v-slot="{ content }">
      <div v-if="layout.compact || !layout.sidebarOpen" class="app-drag flex h-12 shrink-0 items-center border-b border-ui-border pr-3" :class="platform === 'darwin' ? 'pl-20' : 'pl-3'">
        <WindowToolbar />
      </div>
      <PreviewViewer :key="content.content" v-bind="content" mode="focus" class="min-h-0 flex-1 rounded-none border-0" />
    </FocusOverlay>
  </main>
</template>
