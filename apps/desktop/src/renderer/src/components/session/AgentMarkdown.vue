<script setup lang="ts">
import { computed } from "vue"
import { renderMarkdown } from "../../services/markdown.ts"
const props = defineProps<{ text: string }>()
// markdown-it escapes raw HTML, so the rendered output is safe to inject.
const html = computed(() => renderMarkdown(props.text))
</script>

<template>
  <div class="ui-markdown" v-html="html" />
</template>
