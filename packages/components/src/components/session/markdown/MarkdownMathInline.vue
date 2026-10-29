<script setup lang="ts">
import { computed } from "vue"
import { renderCachedMath } from "./context.ts"

const props = defineProps<{
  node: { content?: unknown }
}>()

const tex = computed(() => String(props.node.content ?? ""))
const rendered = computed(() => renderCachedMath(tex.value, false))
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <span v-if="rendered.ok" class="ui-math-inline" data-math-inline="" v-html="rendered.html" />
  <span v-else class="ui-math-inline" data-math-inline="">
    <code class="ui-math-fallback">{{ `$${tex}$` }}</code>
  </span>
</template>
