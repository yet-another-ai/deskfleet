<script setup lang="ts">
import { computed, inject } from "vue"
import MermaidViewer from "../MermaidViewer.vue"
import { markdownHostKey } from "./context.ts"

const props = withDefaults(defineProps<{
  node: { code?: unknown; loading?: boolean }
  indexKey?: string | number
  loading?: boolean
}>(), {
  indexKey: "",
  loading: false,
})

const host = inject(markdownHostKey)
const diagramId = host ? host.allocateDiagramId(String(props.indexKey || "0")) : "0"
const rawCode = computed(() => String(props.node.code ?? "").replace(/\n$/u, "").trim())
const isLoading = computed(() => Boolean(props.loading ?? props.node.loading))
</script>

<template>
  <MermaidViewer
    :data-mermaid="diagramId"
    :code="rawCode"
    mode="inline"
    :loading="isLoading"
  />
</template>
