<script setup lang="ts">
import type { SessionWindowRequest } from "../../stores/layout.ts"
import AgentResourceViewer from "./AgentResourceViewer.vue"
import PreviewViewer from "./PreviewViewer.vue"

defineProps<{ request: SessionWindowRequest }>()
</script>

<template>
  <PreviewViewer
    v-if="request.kind === 'preview'"
    v-bind="request.item"
    mode="tab"
    class="h-full rounded-none border-0"
  />
  <AgentResourceViewer
    v-else
    :request="request.item.request"
    :title="request.item.title"
    :source="request.item.source"
    mode="tab"
    class="h-full"
  />
</template>
