<script setup lang="ts">
import { Check, Copy } from "@lucide/vue"
import { ShikiStreamTokenizer } from "@shikijs/stream"
import type { ThemedToken } from "shiki/core"
import { computed, onBeforeUnmount, shallowRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { canHighlight, codeLanguageName, highlighter } from "../../../services/code-highlight.ts"
import MarkdownMathBlock from "./MarkdownMathBlock.vue"
import MarkdownMermaidNode from "./MarkdownMermaidNode.vue"

const props = withDefaults(defineProps<{
  node: { code?: unknown; language?: unknown; loading?: boolean }
  indexKey?: string | number
  loading?: boolean
}>(), {
  indexKey: "",
  loading: false,
})

const { t } = useI18n()
const stableTokens = shallowRef<ThemedToken[]>([])
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
  canHighlight(language.value) && (stableTokens.value.length > 0 || unstableTokens.value.length > 0),
)

function tokenStyleString(token: ThemedToken): string | undefined {
  const style = token.htmlStyle
  if (!style) return undefined
  if (typeof style === "string") return style
  let out = ""
  for (const [k, v] of Object.entries(style)) {
    if (v) out += `${out ? ";" : ""}${k}:${v}`
  }
  return out || undefined
}

function syncTokens(nextCode: string, lang: string): void {
  if (!canHighlight(lang)) {
    tokenizer = null
    tokenizedCode = ""
    currentLang = lang
    stableTokens.value = []
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
  }
  const delta = nextCode.slice(tokenizedCode.length)
  if (!delta && tokenizedCode.length > 0) return
  tokenizedCode = nextCode
  void tokenizer.enqueue(delta).then(() => {
    stableTokens.value = tokenizer!.tokensStable.slice()
    unstableTokens.value = tokenizer!.tokensUnstable.slice()
  })
}

watch(
  [code, language],
  ([nextCode, lang]) => {
    if (isMermaid.value || isMath.value) return
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
    <pre><code v-if="hasHighlightedTokens"><span class="shiki-stream-stable"><template
      v-for="(tok, idx) in stableTokens"
      :key="idx"
    ><br v-if="tok.content === '\n'"><span v-else :style="tokenStyleString(tok)">{{ tok.content }}</span></template></span><span class="shiki-stream-unstable"><template
      v-for="(tok, idx) in unstableTokens"
      :key="idx"
    ><br v-if="tok.content === '\n'"><span v-else :style="tokenStyleString(tok)">{{ tok.content }}</span></template></span></code><code v-else>{{ code }}</code></pre>
  </div>
</template>
