<script setup lang="ts">
import { Check, Copy } from "@lucide/vue"
import { ShikiStreamTokenizer } from "@shikijs/stream"
import type { ThemedToken } from "shiki/core"
import { computed, onBeforeUnmount, shallowRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { canHighlight, codeLanguageName, highlighter } from "../../../services/code-highlight.ts"
import MarkdownMathBlock from "./MarkdownMathBlock.vue"
import MarkdownMermaidNode from "./MarkdownMermaidNode.vue"
import MarkdownCodeTokens from "./MarkdownCodeTokens.vue"

const props = withDefaults(defineProps<{
  node: { code?: unknown; language?: unknown; loading?: boolean }
  indexKey?: string | number
  loading?: boolean
}>(), {
  indexKey: "",
  loading: false,
})

const { t } = useI18n()
// Completed chunks retain their identity, so Vue only renders the changing tail.
const TOKEN_CHUNK_SIZE = 256
const stableChunks = shallowRef<ThemedToken[][]>([])
const unstableTokens = shallowRef<ThemedToken[]>([])
let tokenizer: ShikiStreamTokenizer | null = null
let tokenizedCode = ""
let currentLang = ""

const rawInfo = computed(() => String(props.node.language ?? "").trim().split(/\s+/u)[0] ?? "")
const language = computed(() => rawInfo.value.toLowerCase())
const rawCode = computed(() => String(props.node.code ?? ""))
const code = computed(() => rawCode.value.replace(/\n$/u, ""))
const isMermaid = computed(() => language.value === "mermaid")
const isMath = computed(() => ["math", "latex", "tex", "katex"].includes(language.value))
const languageName = computed(() => codeLanguageName(language.value) ?? rawInfo.value)
const copyLabel = computed(() => t("common.copy"))
const hasHighlightedTokens = computed(() =>
  canHighlight(language.value) && (stableChunks.value.length > 0 || unstableTokens.value.length > 0),
)

function appendStableTokens(tokens: ThemedToken[]): void {
  if (!tokens.length) return
  const chunks = stableChunks.value.slice()
  let offset = 0
  const tail = chunks.at(-1)
  if (tail && tail.length < TOKEN_CHUNK_SIZE) {
    offset = Math.min(TOKEN_CHUNK_SIZE - tail.length, tokens.length)
    chunks[chunks.length - 1] = [...tail, ...tokens.slice(0, offset)]
  }
  for (; offset < tokens.length; offset += TOKEN_CHUNK_SIZE) {
    chunks.push(tokens.slice(offset, offset + TOKEN_CHUNK_SIZE))
  }
  stableChunks.value = chunks
}

function syncTokens(nextCode: string, lang: string): void {
  if (!canHighlight(lang)) {
    tokenizer = null
    tokenizedCode = ""
    currentLang = lang
    stableChunks.value = []
    unstableTokens.value = []
    return
  }
  if (!tokenizer || currentLang !== lang || !nextCode.startsWith(tokenizedCode)) {
    currentLang = lang
    tokenizer = new ShikiStreamTokenizer({
      highlighter,
      lang,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: "light-dark()",
    })
    tokenizedCode = ""
    stableChunks.value = []
    unstableTokens.value = []
  }
  const delta = nextCode.slice(tokenizedCode.length)
  if (!delta && tokenizedCode.length > 0) return
  tokenizedCode = nextCode
  const activeTokenizer = tokenizer
  void activeTokenizer.enqueue(delta).then(({ stable, unstable }) => {
    if (tokenizer !== activeTokenizer) return
    appendStableTokens(stable)
    unstableTokens.value = unstable
  })
}

watch(
  [code, language],
  ([nextCode, lang]) => {
    syncTokens(nextCode, lang)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  tokenizer?.clear()
  tokenizer = null
})
</script>

<template>
  <MarkdownMermaidNode
    v-if="isMermaid"
    :node="node"
    :index-key="indexKey"
    :loading="loading"
  />
  <MarkdownMathBlock
    v-else-if="isMath"
    :content="rawCode"
  />
  <div v-else class="ui-code-block" data-code-block="">
    <div class="ui-code-header">
      <span v-if="languageName" class="ui-code-language">{{ languageName }}</span>
      <button
        type="button"
        class="ui-button-ghost ui-code-copy h-7 w-7 shrink-0 p-0"
        :data-code-copy="code"
        :aria-label="copyLabel"
        :title="copyLabel"
      >
        <Copy :size="14" data-icon-copy="" aria-hidden="true" />
        <Check :size="14" data-icon-check="" aria-hidden="true" />
      </button>
    </div>
    <pre><code v-if="hasHighlightedTokens"><span class="shiki-stream-stable"><MarkdownCodeTokens
      v-for="(chunk, index) in stableChunks"
      :key="index"
      :tokens="chunk"
    /></span><MarkdownCodeTokens class="shiki-stream-unstable" :tokens="unstableTokens" /></code><code v-else>{{ code }}</code></pre>
  </div>
</template>
