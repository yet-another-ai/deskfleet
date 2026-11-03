<script setup lang="ts">
import type { SessionWindowRequest } from "../../stores/layout.ts"
import MermaidViewer from "./MermaidViewer.vue"
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
  <MermaidViewer
    v-else
    :code="request.code"
    :source="request.source"
    mode="tab"
    class="h-full rounded-none border-0"
  />
</template>
