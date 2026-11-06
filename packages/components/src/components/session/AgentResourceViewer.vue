<script setup lang="ts">
import { LocateFixed } from "@lucide/vue"
import { getActivePinia } from "pinia"
import { DialogTitle } from "reka-ui"
import { splitLines } from "shiki/core"
import { computed, nextTick, onBeforeUnmount, ref, shallowRef } from "vue"
import { useI18n } from "vue-i18n"
import type { FileEntry, FileResourceRequest, FilesApi } from "../../../../client/src/files.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { fileResourceLines } from "../../services/agent-resources.ts"
import { fileCodeLanguage, highlighter } from "../../services/code-highlight.ts"
import { previewKindFromMime, previewKindFromUri, type MediaPreviewKind, type PreviewSource } from "../../services/preview.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import { locatePreviewInMainView } from "../../stores/previews.ts"
import UiDialog from "../common/UiDialog.vue"
import UiButton from "../common/UiButton.vue"
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
const entry = ref<FileEntry>()
const content = ref<string>()
const lines = computed(() => content.value === undefined ? [] : splitLines(content.value, true).map(([text]) => ({
  text,
  ending: text.match(/\r?\n$/u)?.[0] ?? "",
})))
const highlightedLines = computed(() => {
  const language = entry.value && fileCodeLanguage(entry.value.name)
  // Preview reads allow 16 MiB; keep large files out of synchronous tokenization.
  if (!language || content.value === undefined || content.value.length > 200_000) return undefined
  try {
    return highlighter.codeToTokens(content.value, {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: "light-dark()",
    }).tokens
  } catch { return undefined }
})
const requestedLines = fileResourceLines(request.uri)
const lineElement = ref<HTMLElement>()
const imageUrl = ref<string>()
const previewKind = ref<MediaPreviewKind>()
const previewMime = ref<string>()
const previewBytes = shallowRef<Uint8Array>()
const error = ref<string>()
const loading = ref(true)
const downloading = ref(false)
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
      const file = await api.readResource(request)
      if (disposed) return
      const kind = !requestedLines
        ? (previewKindFromMime(file.mimeType) ?? previewKindFromUri(result.name, file.mimeType))
        : undefined
      if (kind) {
        previewKind.value = kind
        previewMime.value = file.mimeType
        previewBytes.value = file.data
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
        } catch { error.value = t("files.previewUnavailable") }
      }
    }
  } catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { if (!disposed) loading.value = false }
}
async function download(): Promise<void> {
  const api = filesApi.value
  if (downloading.value || !api) return
  downloading.value = true
  try { await api.saveResource(request) }
  catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { if (!disposed) downloading.value = false }
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
      mode="tab"
      class="h-full flex-1 rounded-none border-0"
    />
    <template v-else>
      <header class="flex shrink-0 items-center justify-between gap-2 border-b border-ui-border px-4 py-2">
        <span class="min-w-0 truncate text-xs font-medium text-ui-text-muted" :title="entry?.path ?? request.uri">
          {{ entry?.name ?? title ?? request.uri }}
        </span>
        <div class="flex shrink-0 items-center gap-1.5">
          <UiButton
            variant="ghost"
            size="icon"
            :label="t('mermaid.locateMessage')"
            data-preview-action="locate-message"
            @click="locateOriginal"
          ><LocateFixed :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
          <UiButton
            v-if="entry"
            type="button"
            data-preview-action="download"
            :disabled="downloading"
            @click="download"
          >
            {{ t('files.downloadResource') }}
          </UiButton>
        </div>
      </header>
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <p v-if="loading" class="m-0 p-4 text-sm text-ui-text-muted" role="status">{{ t('folderPicker.loading') }}</p>
        <div v-else-if="entry?.kind === 'directory' && filesApi" class="min-h-0 flex-1 overflow-auto p-4">
          <FileBrowserPane :api="filesApi" :target="request.target" :name="entry.name" :initial-path="entry.path" :revision="0" :reset-key="0" :selection="[]" :selectable="false" />
        </div>
        <pre v-else-if="content !== undefined" class="m-0 min-h-0 flex-1 overflow-auto p-4 whitespace-pre text-xs select-text"><code><span
          v-for="(line, index) in lines"
          :key="index"
          :ref="index + 1 === requestedLines?.start ? (element: any) => { lineElement = element } : undefined"
          :class="requestedLines && index + 1 >= requestedLines.start && index + 1 <= requestedLines.end && 'bg-ui-hover'"
        ><template v-if="highlightedLines"><span v-for="(token, tokenIndex) in highlightedLines[index]" :key="tokenIndex" :style="token.htmlStyle">{{ token.content }}</span>{{ line.ending }}</template><template v-else>{{ line.text }}</template></span></code></pre>
        <p v-if="error" class="m-0 p-4 break-words text-sm text-ui-danger" role="alert">{{ error }}</p>
      </div>
    </template>
  </div>
  <UiDialog v-else class="w-[48rem] max-w-[calc(100vw-2rem)]" @close="emit('close')">
    <DialogTitle class="ui-dialog-title mb-3 break-all">{{ entry?.name ?? request.uri }}</DialogTitle>
    <p v-if="loading" role="status">{{ t('folderPicker.loading') }}</p>
    <FileBrowserPane v-else-if="entry?.kind === 'directory' && filesApi" :api="filesApi" :target="request.target" :name="entry.name" :initial-path="entry.path" :revision="0" :reset-key="0" :selection="[]" :selectable="false" />
    <PreviewViewer
      v-else-if="imageUrl && previewKind"
      :kind="previewKind"
      :content="imageUrl"
      :data="previewBytes"
      :mime-type="previewMime"
      :title="entry?.name"
      :resource-request="request"
      mode="inline"
      class="max-h-[60vh]"
    />
    <pre v-else-if="content !== undefined" class="max-h-[60vh] overflow-auto whitespace-pre text-xs select-text"><code><span
      v-for="(line, index) in lines"
      :key="index"
      :ref="index + 1 === requestedLines?.start ? (element: any) => { lineElement = element } : undefined"
      :class="requestedLines && index + 1 >= requestedLines.start && index + 1 <= requestedLines.end && 'bg-ui-hover'"
    ><template v-if="highlightedLines"><span v-for="(token, tokenIndex) in highlightedLines[index]" :key="tokenIndex" :style="token.htmlStyle">{{ token.content }}</span>{{ line.ending }}</template><template v-else>{{ line.text }}</template></span></code></pre>
    <p v-if="error" class="break-words text-sm text-ui-danger" role="alert">{{ error }}</p>
    <div class="mt-4 flex justify-end gap-2">
      <UiButton v-if="entry" type="button" :disabled="downloading" @click="download">{{ t('files.downloadResource') }}</UiButton>
      <UiButton type="button" @click="emit('close')">{{ t('files.close') }}</UiButton>
    </div>
  </UiDialog>
</template>
