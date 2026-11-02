<script lang="ts">
import { setCustomComponents } from "markstream-vue"
import MarkdownCodeBlock from "./markdown/MarkdownCodeBlock.vue"
import MarkdownImageNode from "./markdown/MarkdownImageNode.vue"
import MarkdownLinkNode from "./markdown/MarkdownLinkNode.vue"
import MarkdownMathBlock from "./markdown/MarkdownMathBlock.vue"
import MarkdownMathInline from "./markdown/MarkdownMathInline.vue"
import MarkdownMermaidNode from "./markdown/MarkdownMermaidNode.vue"

const CUSTOM_ID = "deskfleet-markdown"

// Registration invalidates every renderer's parser cache; run once per module,
// not when a new message mounts or a folded response is opened.
setCustomComponents(CUSTOM_ID, {
  code_block: MarkdownCodeBlock,
  mermaid: MarkdownMermaidNode,
  math_block: MarkdownMathBlock,
  math_inline: MarkdownMathInline,
  image: MarkdownImageNode,
  link: MarkdownLinkNode,
})
</script>

<script setup lang="ts">
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { watchImmediate } from "@vueuse/core"
import { MarkdownRender } from "markstream-vue"
import { computed, inject, onBeforeUnmount, provide, reactive, ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import { agentResourceContextKey } from "../../services/agent-resources.ts"
import { agentMarkdownParseOptions, createAgentMarkdownParser } from "../../services/agent-markdown.ts"
import { previewKindFromMime } from "../../services/preview.ts"
import { markdownHostKey, type LoadedImage } from "./markdown/context.ts"
import AgentResourceViewer from "./AgentResourceViewer.vue"
import type { FileResourceRequest } from "../../../../client/src/files.ts"

const client = usePlatformClient()

const props = defineProps<{ text: string; final?: boolean }>()
const parseMarkdown = createAgentMarkdownParser(useId())
const nodes = computed(() => parseMarkdown(props.text, props.final ?? true))
const { t } = useI18n()
const context = inject(agentResourceContextKey, computed(() => undefined))
const error = ref<string>()
const resource = ref<FileResourceRequest>()
const files = client.files

const images = reactive(new Map<string, LoadedImage>())
const diagramIds = new Map<string, string>()
let nextDiagramId = 0
let contextKey = ""
let disposed = false

function release(uri: string): void {
  const image = images.get(uri)
  if (image?.url) URL.revokeObjectURL(image.url)
  images.delete(uri)
}

function load(uri: string, refCount = 1): void {
  const existing = images.get(uri)
  const value: LoadedImage = reactive({ refCount: existing?.refCount ?? refCount })
  images.set(uri, value)
  const current = context.value
  if (!files || !current) {
    value.error = t("files.resourceUnavailable")
    return
  }
  void files.readResource({ ...current, uri }).then(result => {
    if (disposed || images.get(uri) !== value) return
    // Markdown embeds share PreviewViewer's image, audio, and video support.
    if (!previewKindFromMime(result.mimeType)) {
      throw new Error(t("files.previewUnavailable"))
    }
    value.mimeType = result.mimeType
    value.url = URL.createObjectURL(new Blob([new Uint8Array(result.data)], { type: result.mimeType }))
  }).catch(reason => {
    if (images.get(uri) === value) value.error = reason instanceof Error ? reason.message : String(reason)
  })
}

watchImmediate(context, current => {
  const key = JSON.stringify(current)
  if (contextKey === key) return
  const retainedEntries = [...images.entries()].filter(([, img]) => img.refCount > 0)
  for (const uri of images.keys()) release(uri)
  contextKey = key
  error.value = undefined
  resource.value = undefined
  for (const [uri, img] of retainedEntries) {
    load(uri, img.refCount)
  }
})

provide(markdownHostKey, {
  useImage: (uri: string) => images.get(uri),
  retainImage: (uri: string) => {
    const existing = images.get(uri)
    if (existing) {
      existing.refCount++
    } else {
      load(uri, 1)
    }
  },
  releaseImage: (uri: string) => {
    const existing = images.get(uri)
    if (!existing) return
    existing.refCount--
    if (existing.refCount <= 0) {
      release(uri)
    }
  },
  allocateDiagramId: (indexKey: string) => {
    const existing = diagramIds.get(indexKey)
    if (existing !== undefined) return existing
    const id = String(nextDiagramId++)
    diagramIds.set(indexKey, id)
    return id
  },
})

async function click(event: MouseEvent): Promise<void> {
  const target = event.target instanceof Element ? event.target : null
  const copyButton = target?.closest<HTMLButtonElement>("[data-math-copy], [data-code-copy]")
  if (copyButton) {
    event.preventDefault()
    try { await navigator.clipboard.writeText(copyButton.dataset.mathCopy ?? copyButton.dataset.codeCopy ?? "") } catch { return }
    const setCopied = (copied: boolean) => {
      if (copied) copyButton.dataset.copied = "true"; else delete copyButton.dataset.copied
      const label = t(copied ? "common.copied" : "common.copy")
      copyButton.setAttribute("aria-label", label); copyButton.title = label
    }
    setCopied(true)
    setTimeout(() => { if (!disposed) setCopied(false) }, 1500)
    return
  }
  const retry = target?.closest<HTMLButtonElement>("[data-resource-retry]")
  if (retry?.dataset.resourceRetry) {
    event.preventDefault()
    const uri = retry.dataset.resourceRetry
    const refCount = images.get(uri)?.refCount ?? 1
    release(uri)
    load(uri, refCount)
    return
  }
  const link = target?.closest<HTMLAnchorElement>("a[data-resource-link]")
  if (!link) return
  event.preventDefault()
  if (!files || !context.value) { error.value = t("files.resourceUnavailable"); return }
  error.value = undefined
  resource.value = { ...context.value, uri: link.dataset.resourceLink! }
}

onBeforeUnmount(() => {
  disposed = true
  for (const uri of images.keys()) release(uri)
})
</script>

<template>
  <div>
    <div class="ui-markdown" data-reading-surface @click="click">
      <!-- Chat updates already arrive incrementally; do not queue another delayed reveal. -->
      <MarkdownRender
        :nodes="nodes"
        :custom-id="CUSTOM_ID"
        :final="final ?? true"
        :parse-options="agentMarkdownParseOptions"
        :smooth-streaming="false"
        :batch-rendering="false"
        :max-live-nodes="0"
        :typewriter="false"
        :fade="false"
      />
    </div>
    <AgentResourceViewer v-if="resource && files" :key="JSON.stringify(resource)" :api="files" :request="resource" @close="resource = undefined" />
    <p v-if="error" class="mt-2 text-xs text-ui-danger" role="alert">{{ error }}</p>
  </div>
</template>
