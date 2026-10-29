<script setup lang="ts">
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { watchImmediate } from "@vueuse/core"
import { MarkdownRender, setCustomComponents } from "markstream-vue"
import { computed, inject, onBeforeUnmount, provide, reactive, ref } from "vue"
import { useI18n } from "vue-i18n"
import { agentResourceContextKey, isFileResource } from "../../services/agent-resources.ts"
import { markdownHostKey, type LoadedImage } from "./markdown/context.ts"
import MarkdownCodeBlock from "./markdown/MarkdownCodeBlock.vue"
import MarkdownImageNode from "./markdown/MarkdownImageNode.vue"
import MarkdownLinkNode from "./markdown/MarkdownLinkNode.vue"
import MarkdownMathBlock from "./markdown/MarkdownMathBlock.vue"
import MarkdownMathInline from "./markdown/MarkdownMathInline.vue"
import MarkdownMermaidNode from "./markdown/MarkdownMermaidNode.vue"

const client = usePlatformClient()

defineProps<{ text: string; final?: boolean }>()
const { t } = useI18n()
const context = inject(agentResourceContextKey, computed(() => undefined))
const error = ref<string>()
const saving = ref(false)
const files = client.files

const CUSTOM_ID = "deskfleet-markdown"

setCustomComponents(CUSTOM_ID, {
  code_block: MarkdownCodeBlock,
  mermaid: MarkdownMermaidNode,
  math_block: MarkdownMathBlock,
  math_inline: MarkdownMathInline,
  image: MarkdownImageNode,
  link: MarkdownLinkNode,
})

const images = reactive(new Map<string, LoadedImage>())
const diagramIds = new Map<string, string>()
let nextDiagramId = 0
let contextKey = ""
let generation = 0
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
    if (!/^image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml|vnd\.microsoft\.icon|x-icon)$/iu.test(result.mimeType)) {
      throw new Error(t("files.notImage"))
    }
    value.url = URL.createObjectURL(new Blob([new Uint8Array(result.data)], { type: result.mimeType }))
  }).catch(reason => {
    if (images.get(uri) === value) value.error = reason instanceof Error ? reason.message : String(reason)
  })
}

watchImmediate(context, current => {
  const key = JSON.stringify(current)
  if (contextKey === key) return
  ++generation
  const retainedEntries = [...images.entries()].filter(([, img]) => img.refCount > 0)
  for (const uri of images.keys()) release(uri)
  contextKey = key
  error.value = undefined
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

function customizeMarkdownIt(md: any) {
  const validate = md.validateLink.bind(md)
  md.validateLink = (value: string) => isFileResource(value) || validate(value)
  return md
}

const parseOptions = {
  validateLink: (url: string) => isFileResource(url) || !/^(?:javascript|vbscript|data):/iu.test(url.trim()),
}

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
  if (saving.value) return
  if (!files || !context.value) { error.value = t("files.resourceUnavailable"); return }
  saving.value = true; error.value = undefined
  const version = generation
  try { await files.saveResource({ ...context.value, uri: link.dataset.resourceLink! }) }
  catch (reason) { if (!disposed && version === generation) error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { if (!disposed) saving.value = false }
}

onBeforeUnmount(() => {
  disposed = true
  ++generation
  for (const uri of images.keys()) release(uri)
})
</script>

<template>
  <div>
    <div class="ui-markdown" :aria-busy="saving" @click="click">
      <MarkdownRender
        :content="text"
        :custom-id="CUSTOM_ID"
        :final="final ?? true"
        :custom-markdown-it="customizeMarkdownIt"
        :parse-options="parseOptions"
        :smooth-streaming="false"
        :batch-rendering="false"
        :defer-nodes-until-visible="false"
        :viewport-priority="false"
        :typewriter="false"
        :fade="false"
        render-as-fragment
      />
    </div>
    <p v-if="error" class="mt-2 text-xs text-ui-danger" role="alert">{{ error }}</p>
  </div>
</template>
