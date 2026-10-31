<script setup lang="ts">
import { computed } from "vue"

const props = defineProps<{ text: string; query: string }>()
const parts = computed(() => {
  const query = props.query.trim()
  if (!query) return [{ text: props.text, match: false }]
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu")
  const result: { text: string; match: boolean }[] = []
  let position = 0
  for (const match of props.text.matchAll(expression)) {
    result.push({ text: props.text.slice(position, match.index), match: false }, { text: match[0], match: true })
    position = match.index + match[0].length
  }
  result.push({ text: props.text.slice(position), match: false })
  return result
})
</script>

<template>
  <template v-for="(part, index) in parts" :key="index"><mark v-if="part.match" class="rounded-sm bg-ui-accent/15 text-inherit">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template>
</template>
