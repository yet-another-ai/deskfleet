<script setup lang="ts">
import { client } from "@deskfleet/client/platform"
import { watchImmediate } from "@vueuse/core"
import { computed, inject, nextTick, onBeforeUnmount, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import { agentResourceContextKey } from "../../services/agent-resources.ts"
import { renderResourceMarkdown, type MarkdownDiagram } from "../../services/markdown.ts"
import MermaidViewer from "./MermaidViewer.vue"

const props = defineProps<{ text: string }>()
const { t, locale } = useI18n()
const context = inject(agentResourceContextKey, computed(() => undefined))
const rendered = computed(() => renderResourceMarkdown(props.text))
const surface = useTemplateRef<HTMLDivElement>("surface")
const error = ref<string>()
const saving = ref(false)
const files = client.files
interface LoadedImage { url?: string; error?: string }
interface MarkdownSegment { key: string; html?: string; diagram?: MarkdownDiagram }
const images = new Map<string, LoadedImage>()
let contextKey = ""
let generation = 0
let disposed = false

const segments = computed<MarkdownSegment[]>(() => {
  const { html, diagrams } = rendered.value
  if (!diagrams.length) return [{ key: "html-0", html }]
  const byId = new Map(diagrams.map(diagram => [diagram.id, diagram]))
  return html.split(/(<div class="ui-mermaid" data-mermaid="\d+"><pre><code>[\s\S]*?<\/code><\/pre><\/div>\n?)/gu).flatMap<MarkdownSegment>((part, i) => {
    const match = /^<div class="ui-mermaid" data-mermaid="(\d+)">/u.exec(part)
    const diagram = match && byId.get(match[1]!)
    return diagram ? [{ key: `mermaid-${diagram.id}`, diagram }] : part ? [{ key: `html-${i}`, html: part }] : []
  })
})

function release(uri: string): void {
  const image = images.get(uri)
  if (image?.url) URL.revokeObjectURL(image.url)
  images.delete(uri)
}
function hydrate(): void {
  for (const resource of rendered.value.resources) {
    const holder = surface.value?.querySelector(`[data-resource-image="${resource.id}"]`)
    if (!holder) continue
    const image = images.get(resource.uri)
    if (image?.url) {
      const element = document.createElement("img")
      element.src = image.url; element.alt = resource.alt
      holder.replaceChildren(element)
    } else if (image?.error) {
      const retry = document.createElement("button")
      retry.type = "button"; retry.className = "ui-button"
      retry.dataset.resourceRetry = resource.uri
      retry.textContent = resource.alt || t("files.imageUnavailable")
      retry.title = `${image.error} \u2014 ${t("files.retry")}`
      holder.replaceChildren(retry)
    } else {
      const loading = document.createElement("span")
      loading.className = "text-sm text-ui-text-muted"
      loading.textContent = t("files.loadingResource")
      holder.replaceChildren(loading)
    }
  }
  for (const button of surface.value?.querySelectorAll<HTMLButtonElement>("[data-math-copy], [data-code-copy]") ?? []) {
    const label = t(button.dataset.copied === "true" ? "common.copied" : "common.copy")
    button.setAttribute("aria-label", label)
    button.title = label
  }
}
function load(uri: string): void {
  const value: LoadedImage = {}
  images.set(uri, value)
  const current = context.value
  if (!files || !current) { value.error = t("files.resourceUnavailable"); return }
  void files.readResource({ ...current, uri }).then(result => {
    if (disposed || images.get(uri) !== value) return
    if (!/^image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml|vnd\.microsoft\.icon|x-icon)$/iu.test(result.mimeType)) throw new Error(t("files.notImage"))
    // The only URL exposed to img is created here from the authenticated file bytes.
    value.url = URL.createObjectURL(new Blob([new Uint8Array(result.data)], { type: result.mimeType }))
  }).catch(reason => {
    if (images.get(uri) === value) value.error = reason instanceof Error ? reason.message : String(reason)
  }).finally(() => { if (!disposed && images.get(uri) === value) hydrate() })
}
watchImmediate([rendered, context, locale], async () => {
  const version = ++generation
  const key = JSON.stringify(context.value)
  if (contextKey !== key) {
    for (const uri of images.keys()) release(uri)
    contextKey = key; error.value = undefined
  }
  const used = new Set(rendered.value.resources.map(resource => resource.uri))
  for (const uri of images.keys()) if (!used.has(uri)) release(uri)
  for (const uri of used) if (!images.has(uri)) load(uri)
  await nextTick()
  if (!disposed && version === generation) hydrate()
}, { flush: "post" })

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
    release(retry.dataset.resourceRetry); load(retry.dataset.resourceRetry); hydrate()
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
    <div v-if="!rendered.diagrams.length" ref="surface" class="ui-markdown" :aria-busy="saving" @click="click" v-html="rendered.html" />
    <div v-else ref="surface" class="ui-markdown" :aria-busy="saving" @click="click">
      <template v-for="segment in segments" :key="segment.key">
        <MermaidViewer v-if="segment.diagram" :data-mermaid="segment.diagram.id" :code="segment.diagram.code" mode="inline" />
        <div v-else-if="segment.html" class="ui-markdown-segment" v-html="segment.html" />
      </template>
    </div>
    <p v-if="error" class="mt-2 text-xs text-ui-danger" role="alert">{{ error }}</p>
  </div>
</template>
