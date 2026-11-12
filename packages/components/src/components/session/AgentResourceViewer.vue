<script setup lang="ts">
import { vSpring } from "../../directives/spring.ts"
import { Download, ExternalLink, FolderOpen, LocateFixed } from "@lucide/vue"
import { getActivePinia } from "pinia"
import { DialogTitle } from "reka-ui"
import { splitLines } from "shiki/core"
import { computed, nextTick, onBeforeUnmount, ref, shallowRef } from "vue"
import { useI18n } from "vue-i18n"
import type { FileResource, FileResourceRequest, FilesApi } from "../../../../client/src/files.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { fileResourceLines, revealResourceLabel } from "../../services/agent-resources.ts"
import { fileCodeLanguage, highlighter } from "../../services/code-highlight.ts"
import { previewKindFromMime, previewKindFromUri, type MediaPreviewKind, type PreviewSource } from "../../services/preview.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import { locatePreviewInMainView } from "../../stores/previews.ts"
import UiDialog from "../common/UiDialog.vue"
import UiButton from "../common/UiButton.vue"
import UiScrollArea from "../common/UiScrollArea.vue"
import FileBrowserPane from "../files/FileBrowserPane.vue"
import PreviewViewer from "./PreviewViewer.vue"

const props = withDefaults(defineProps<{
  api?: FilesApi
  request: FileResourceRequest
  title?: string
  source?: PreviewSource
  mode?: "dialog" | "tab"
}>(), {
  mode: "dialog",
})
// Vue proxies cannot cross Electron's context bridge, including nested targets.
const request: FileResourceRequest = { ...props.request, target: { ...props.request.target } }
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const client = usePlatformClient()
const filesApi = computed(() => props.api ?? client.files)
const entry = ref<FileResource>()
const canOpenResource = computed(() => Boolean(entry.value?.canOpen && filesApi.value?.openResource))
const canRevealResource = computed(() => Boolean(entry.value?.canOpen && filesApi.value?.revealResource))
const hasFileActions = computed(() => !loading.value && entry.value?.kind === "file")
const hasPrimaryAction = computed(() => hasFileActions.value && (canOpenResource.value || !canRevealResource.value))
const primaryActionLabel = computed(() => t(canOpenResource.value ? "files.openResource" : "files.downloadResource"))
const revealLabel = computed(() => revealResourceLabel(client.platform, t))
const content = ref<string>()
const isHtmlContent = computed(() => content.value !== undefined && Boolean(entry.value && fileCodeLanguage(entry.value.name) === "html"))
const renderingHtml = ref(false)
const lines = computed(() => content.value === undefined ? [] : splitLines(content.value, true).filter(([text]) => text).map(([text]) => ({
  text,
  ending: text.match(/\r?\n$/u)?.[0] ?? "",
})))
const highlightedLines = computed(() => {
  const language = entry.value && fileCodeLanguage(entry.value.name)
  // Local previews may be large; keep them out of synchronous tokenization.
  if (!language || content.value === undefined || content.value.length > 200_000) return undefined
  try {
    return highlighter.codeToTokens(content.value, {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    }).tokens
  } catch { return undefined }
})
const requestedLines = fileResourceLines(request.uri)
const lineElement = ref<HTMLElement>()
const imageUrl = ref<string>()
let htmlPreviewSent = false
const previewKind = ref<MediaPreviewKind>()
const previewMime = ref<string>()
const previewBytes = shallowRef<Uint8Array>()
const loadPercent = ref<number>()
const error = ref<string>()
const loading = ref(true)
let disposed = false
async function open(): Promise<void> {
  const api = filesApi.value
  if (!api) {
    error.value = t("files.resourceUnavailable")
    loading.value = false
    return
  }
  try {
    const result = await api.resolveResource(request)
    if (disposed) return
    entry.value = result
    if (result.kind === "file") {
      if (typeof result.size === "number") loadPercent.value = 0
      const file = await api.readResource(request, {
        onProgress: ({ transferredBytes, totalBytes }) => {
          if (!disposed) loadPercent.value = totalBytes ? Math.min(100, Math.floor(transferredBytes / totalBytes * 100)) : 100
        },
      })
      if (disposed) return
      previewMime.value = file.mimeType
      previewBytes.value = file.data
      const kind = !requestedLines
        ? (previewKindFromMime(file.mimeType) ?? previewKindFromUri(result.name, file.mimeType))
        : undefined
      if (kind) {
        previewKind.value = kind
        imageUrl.value = URL.createObjectURL(new Blob([new Uint8Array(file.data)], { type: file.mimeType }))
      } else {
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(file.data)
          if (text.includes("\0")) throw new Error("Binary file")
          content.value = text
          if (requestedLines) {
            loading.value = false
            await nextTick()
            lineElement.value?.scrollIntoView({ block: "center" })
          }
        } catch { error.value = t((canOpenResource.value || canRevealResource.value) ? "files.previewUnavailableLocal" : "files.previewUnavailable") }
      }
    }
  } catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { if (!disposed) loading.value = false }
}
async function runAction(task: () => Promise<unknown>): Promise<void> {
  try { await task() }
  catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason) }
}
async function fileAction(): Promise<void> {
  if (entry.value?.kind !== "file") return
  if (canOpenResource.value) return runAction(() => filesApi.value!.openResource!(request))
  if (!previewBytes.value) return runAction(() => filesApi.value?.saveResource(request) ?? Promise.resolve())
  imageUrl.value ??= URL.createObjectURL(new Blob([new Uint8Array(previewBytes.value)], { type: previewMime.value }))
  const link = document.createElement("a")
  link.href = imageUrl.value
  link.download = entry.value.name
  link.click()
}
function revealResource(): Promise<void> | undefined {
  if (entry.value?.kind === "file" && canRevealResource.value) return runAction(() => filesApi.value!.revealResource!(request))
}
function locateOriginal(): void {
  const pinia = getActivePinia()
  if (props.mode === "tab" && pinia) useLayoutStore(pinia).closeCompactPanel()
  void locatePreviewInMainView(request.uri, {
    ...props.source,
    sessionId: props.source?.sessionId ?? request.sessionId,
    itemId: request.uri,
  })
}
function sendHtmlPreview(event: Event): void {
  if (htmlPreviewSent || content.value === undefined) return
  const frame = event.currentTarget instanceof HTMLIFrameElement ? event.currentTarget : undefined
  if (!frame?.contentWindow) return
  htmlPreviewSent = true
  frame.contentWindow.postMessage({ html: content.value }, "*")
}
async function toggleHtmlPreview(): Promise<void> {
  htmlPreviewSent = false
  renderingHtml.value = !renderingHtml.value
  if (!renderingHtml.value && requestedLines) {
    await nextTick()
    lineElement.value?.scrollIntoView({ block: "center" })
  }
}
void open()
onBeforeUnmount(() => { disposed = true; if (imageUrl.value) URL.revokeObjectURL(imageUrl.value) })
</script>

<template>
  <div
    v-if="mode === 'tab'"
    data-resource-viewer
    data-resource-viewer-mode="tab"
    :data-resource-uri="request.uri"
    class="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-ui-surface text-ui-text"
  >
    <PreviewViewer
      v-if="!loading && imageUrl && previewKind"
      :kind="previewKind"
      :content="imageUrl"
      :data="previewBytes"
      :mime-type="previewMime"
      :title="entry?.name ?? title"
      :source="{ ...source, sessionId: source?.sessionId ?? request.sessionId, itemId: request.uri }"
      :resource-request="request"
      :api="filesApi"
      :can-open="entry?.canOpen"
      mode="tab"
      class="h-full flex-1 rounded-none border-0"
    />
    <template v-else>
      <header class="flex shrink-0 items-center justify-between gap-2 border-b border-ui-border px-4 py-1.5">
        <span class="min-w-0 truncate text-xs font-medium text-ui-text-muted" :title="entry?.path ?? request.uri">
          {{ entry?.name ?? title ?? request.uri }}
        </span>
        <div class="flex shrink-0 items-center gap-0.5">
          <UiButton v-if="isHtmlContent" type="button" variant="ghost" size="sm" :data-preview-action="renderingHtml ? 'source' : 'preview-html'" @click="toggleHtmlPreview">{{ t(renderingHtml ? 'files.viewSource' : 'files.previewHtml') }}</UiButton>
          <UiButton variant="ghost" size="icon" :label="t('mermaid.locateMessage')" data-preview-action="locate-message" @click="locateOriginal"><LocateFixed :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
          <UiButton v-if="hasFileActions && canRevealResource" variant="ghost" size="icon" :label="revealLabel" data-preview-action="reveal" @click="revealResource"><FolderOpen :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
          <UiButton v-if="hasPrimaryAction" variant="ghost" size="icon" :label="primaryActionLabel" :data-preview-action="canOpenResource ? 'open' : 'download'" @click="fileAction"><component :is="canOpenResource ? ExternalLink : Download" :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
        </div>
      </header>
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div v-if="loading" class="flex flex-col gap-2 p-4 text-sm text-ui-text-muted" role="status">
          <div class="flex items-center justify-between gap-2">
            <span>{{ t('folderPicker.loading') }}</span>
            <span v-if="loadPercent !== undefined" class="text-xs tabular-nums">{{ loadPercent }}%</span>
          </div>
          <div v-if="loadPercent !== undefined" class="h-1 w-full overflow-hidden rounded-full bg-ui-hover" role="progressbar" :aria-valuenow="loadPercent" aria-valuemin="0" aria-valuemax="100">
            <div class="h-full bg-ui-accent" v-spring.enter="{ width: `${loadPercent}%` }" />
          </div>
        </div>
        <UiScrollArea v-else-if="entry?.kind === 'directory' && filesApi" orientation="both" class="min-h-0 flex-1" viewport-class="p-4">
          <FileBrowserPane :api="filesApi" :target="request.target" :name="entry.name" :initial-path="entry.path" :revision="0" :reset-key="0" :selection="[]" :selectable="false" />
        </UiScrollArea>
        <iframe v-else-if="isHtmlContent && renderingHtml" data-html-preview src="./html-preview.html" sandbox="allow-scripts allow-forms" :title="entry?.name ?? title ?? request.uri" class="min-h-0 w-full flex-1 border-0 bg-white" @load="sendHtmlPreview" />
        <UiScrollArea v-else-if="content !== undefined" orientation="both" class="min-h-0 flex-1">
          <pre class="m-0 p-4 whitespace-pre text-xs select-text"><code><span
            v-for="(line, index) in lines"
            :key="index"
            :ref="index + 1 === requestedLines?.start ? (element: any) => { lineElement = element } : undefined"
            :data-line="index + 1"
            class="before:mr-3 before:inline-block before:min-w-8 before:text-right before:text-ui-text-faint before:tabular-nums before:select-none"
            :class="requestedLines && index + 1 >= requestedLines.start && index + 1 <= requestedLines.end && 'bg-ui-hover'"
          ><template v-if="highlightedLines"><span v-for="(token, tokenIndex) in highlightedLines[index]" :key="tokenIndex" :style="token.htmlStyle">{{ token.content }}</span>{{ line.ending }}</template><template v-else>{{ line.text }}</template></span></code></pre>
        </UiScrollArea>
        <div v-if="error" class="flex flex-col items-start gap-3 p-4">
          <p class="m-0 break-words text-sm text-ui-danger" role="alert">{{ error }}</p>
          <div v-if="hasFileActions && content === undefined" data-preview-error-actions class="flex flex-wrap items-center gap-2">
            <UiButton v-if="canRevealResource" type="button" data-preview-action="reveal" @click="revealResource"><FolderOpen :size="15" aria-hidden="true" />{{ revealLabel }}</UiButton>
            <UiButton v-if="hasPrimaryAction" type="button" :data-preview-action="canOpenResource ? 'open' : 'download'" @click="fileAction"><component :is="canOpenResource ? ExternalLink : Download" :size="15" aria-hidden="true" />{{ primaryActionLabel }}</UiButton>
          </div>
        </div>
      </div>
    </template>
  </div>
  <UiDialog v-else class="w-[48rem] max-w-[calc(100vw-2rem)]" @close="emit('close')">
    <DialogTitle class="ui-dialog-title mb-3 break-all">{{ entry?.name ?? request.uri }}</DialogTitle>
    <div v-if="loading" class="flex flex-col gap-2 text-sm text-ui-text-muted" role="status">
      <div class="flex items-center justify-between gap-2">
        <span>{{ t('folderPicker.loading') }}</span>
        <span v-if="loadPercent !== undefined" class="text-xs tabular-nums">{{ loadPercent }}%</span>
      </div>
      <div v-if="loadPercent !== undefined" class="h-1 w-full overflow-hidden rounded-full bg-ui-hover" role="progressbar" :aria-valuenow="loadPercent" aria-valuemin="0" aria-valuemax="100">
        <div class="h-full bg-ui-accent" v-spring.enter="{ width: `${loadPercent}%` }" />
      </div>
    </div>
    <FileBrowserPane v-else-if="entry?.kind === 'directory' && filesApi" :api="filesApi" :target="request.target" :name="entry.name" :initial-path="entry.path" :revision="0" :reset-key="0" :selection="[]" :selectable="false" />
    <PreviewViewer
      v-else-if="imageUrl && previewKind"
      :kind="previewKind"
      :content="imageUrl"
      :data="previewBytes"
      :mime-type="previewMime"
      :title="entry?.name"
      :resource-request="request"
      :api="filesApi"
      :can-open="entry?.canOpen"
      mode="inline"
      class="max-h-[60vh]"
    />
    <iframe v-else-if="isHtmlContent && renderingHtml" data-html-preview src="./html-preview.html" sandbox="allow-scripts allow-forms" :title="entry?.name ?? request.uri" class="h-[60vh] w-full rounded border border-ui-border bg-white" @load="sendHtmlPreview" />
    <UiScrollArea v-else-if="content !== undefined" orientation="both" fade-size="sm" class="max-h-[60vh]">
      <pre class="m-0 whitespace-pre text-xs select-text"><code><span
        v-for="(line, index) in lines"
        :key="index"
        :ref="index + 1 === requestedLines?.start ? (element: any) => { lineElement = element } : undefined"
        :data-line="index + 1"
        class="before:mr-3 before:inline-block before:min-w-8 before:text-right before:text-ui-text-faint before:tabular-nums before:select-none"
        :class="requestedLines && index + 1 >= requestedLines.start && index + 1 <= requestedLines.end && 'bg-ui-hover'"
      ><template v-if="highlightedLines"><span v-for="(token, tokenIndex) in highlightedLines[index]" :key="tokenIndex" :style="token.htmlStyle">{{ token.content }}</span>{{ line.ending }}</template><template v-else>{{ line.text }}</template></span></code></pre>
    </UiScrollArea>
    <p v-if="error" class="break-words text-sm text-ui-danger" role="alert">{{ error }}</p>
    <div class="mt-4 flex justify-end gap-2">
      <UiButton v-if="isHtmlContent" type="button" variant="ghost" :data-preview-action="renderingHtml ? 'source' : 'preview-html'" @click="toggleHtmlPreview">{{ t(renderingHtml ? 'files.viewSource' : 'files.previewHtml') }}</UiButton>
      <UiButton v-if="hasFileActions && canRevealResource" type="button" data-preview-action="reveal" @click="revealResource">{{ revealLabel }}</UiButton>
      <UiButton v-if="hasPrimaryAction" type="button" :data-preview-action="canOpenResource ? 'open' : 'download'" @click="fileAction">{{ primaryActionLabel }}</UiButton>
      <UiButton type="button" @click="emit('close')">{{ t('files.close') }}</UiButton>
    </div>
  </UiDialog>
</template>

<style scoped>
[data-line]::before { content: attr(data-line); }
</style>
