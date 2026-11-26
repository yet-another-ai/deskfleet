<script setup lang="ts">
import { splitLines } from "shiki/core"
import { computed, nextTick, onMounted, ref, watch } from "vue"
import { fileCodeLanguage, highlighter } from "../../services/code-highlight.ts"
import UiScrollArea from "../common/UiScrollArea.vue"

const props = defineProps<{
  content: string
  filename?: string
  requestedLines?: { start: number; end: number }
  compact?: boolean
}>()

const lineElement = ref<HTMLElement>()
const fileLanguage = computed(() => props.filename ? fileCodeLanguage(props.filename) : undefined)
const lines = computed(() => splitLines(props.content, true).filter(([text]) => text).map(([text]) => ({
  text,
  ending: text.match(/\r?\n$/u)?.[0] ?? "",
})))
const highlightedLines = computed(() => {
  // Local previews may be large; keep them out of synchronous tokenization.
  if (!fileLanguage.value || props.content.length > 200_000) return undefined
  try {
    return highlighter.codeToTokens(props.content, {
      lang: fileLanguage.value,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    }).tokens
  } catch {
    return undefined
  }
})

async function scrollToRequestedLine(): Promise<void> {
  if (!props.requestedLines) return
  await nextTick()
  lineElement.value?.scrollIntoView({ block: "center" })
}

onMounted(() => { void scrollToRequestedLine() })
watch(() => [props.requestedLines?.start, props.requestedLines?.end, props.content] as const, () => {
  void scrollToRequestedLine()
})
</script>

<template>
  <UiScrollArea
    orientation="both"
    :fade-size="compact ? 'sm' : undefined"
    :class="compact ? 'max-h-[60vh]' : 'min-h-0 flex-1'"
  >
    <pre class="m-0 whitespace-pre text-xs select-text" :class="compact ? 'p-3' : 'p-4'"><code><span
      v-for="(line, index) in lines"
      :key="index"
      :ref="index + 1 === requestedLines?.start ? (element: any) => { lineElement = element } : undefined"
      :data-line="index + 1"
      class="before:mr-3 before:inline-block before:min-w-8 before:text-right before:text-ui-text-faint before:tabular-nums before:select-none"
      :class="requestedLines && index + 1 >= requestedLines.start && index + 1 <= requestedLines.end && 'bg-ui-hover'"
    ><template v-if="highlightedLines"><span v-for="(token, tokenIndex) in highlightedLines[index]" :key="tokenIndex" :style="token.htmlStyle">{{ token.content }}</span>{{ line.ending }}</template><template v-else>{{ line.text }}</template></span></code></pre>
  </UiScrollArea>
</template>

<style scoped>
[data-line]::before { content: attr(data-line); }
</style>
