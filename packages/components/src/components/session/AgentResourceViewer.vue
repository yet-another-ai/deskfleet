<script setup lang="ts">
import { vSpring } from "../../directives/spring.ts"
import { Download, ExternalLink, FolderOpen } from "@lucide/vue"
import { getActivePinia } from "pinia"
import { DialogTitle } from "reka-ui"
import { computed, onBeforeUnmount, provide, ref, shallowRef } from "vue"
import { useI18n } from "vue-i18n"
import type { FileResource, FileResourceRequest, FilesApi } from "@deskfleet/client/files"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { agentResourceContextKey, fileResourceLines, revealResourceLabel } from "../../services/agent-resources.ts"
import { decodeUtf8Text, resolvePreviewFormat, type PreviewSource } from "../../services/preview.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import { locatePreviewInMainView } from "../../stores/previews.ts"
import UiButton from "../common/UiButton.vue"
import UiDialog from "../common/UiDialog.vue"
import UiScrollArea from "../common/UiScrollArea.vue"
import FileBrowserPane from "../files/FileBrowserPane.vue"
import PreviewToolbar from "./PreviewToolbar.vue"
import PreviewViewer from "./PreviewViewer.vue"

const props = withDefaults(defineProps<{
  api?: FilesApi
  request?: FileResourceRequest
  /** A message attachment already read from its authenticated workspace. */
  file?: { name: string; mimeType: string; data: Uint8Array }
  title?: string
  source?: PreviewSource
  mode?: "dialog" | "tab"
}>(), {
  mode: "dialog",
})

// Vue proxies cannot cross Electron's context bridge, including nested targets.
const request = props.request && { ...props.request, target: { ...props.request.target } }
const uri = request?.uri ?? props.file?.name ?? ""
provide(agentResourceContextKey, computed(() => request ? { target: { ...request.target }, sessionId: request.sessionId } : undefined))

const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const client = usePlatformClient()
const filesApi = computed(() => props.file ? undefined : props.api ?? client.files)
const requestedLines = request && fileResourceLines(request.uri)
const entry = ref<FileResource>()
const content = ref<string>()
const previewMime = ref<string>()
const previewBytes = shallowRef<Uint8Array>()
const downloadUrl = ref<string>()
const loadPercent = ref<number>()
const error = ref<string>()
const loading = ref(true)
let disposed = false

const canOpenResource = computed(() => Boolean(entry.value?.canOpen && filesApi.value?.openResource))
const canRevealResource = computed(() => Boolean(entry.value?.canOpen && filesApi.value?.revealResource))
const hasFileActions = computed(() => !loading.value && entry.value?.kind === "file")
const hasPrimaryAction = computed(() => hasFileActions.value && (canOpenResource.value || !canRevealResource.value))
const primaryActionLabel = computed(() => t(canOpenResource.value ? "files.openResource" : "files.downloadResource"))
const revealLabel = computed(() => revealResourceLabel(client.platform, t))
const displayTitle = computed(() => entry.value?.name ?? props.title ?? uri)
const fileReady = computed(() => !loading.value && entry.value?.kind === "file" && !error.value)

async function open(): Promise<void> {
  const api = filesApi.value
  if (!props.file && !(api && request)) {
    error.value = t("files.resourceUnavailable")
    loading.value = false
    return
  }
  try {
    const result: FileResource = props.file ? {
      kind: "file", name: props.file.name, path: "", size: props.file.data.byteLength, modifiedAt: 0,
    } : await api!.resolveResource(request!)
    if (disposed) return
    entry.value = result
    if (result.kind === "file") {
      if (typeof result.size === "number") loadPercent.value = 0
      const file = props.file ?? await api!.readResource(request!, {
        onProgress: ({ transferredBytes, totalBytes }) => {
          if (!disposed) loadPercent.value = totalBytes ? Math.min(100, Math.floor(transferredBytes / totalBytes * 100)) : 100
        },
      })
      if (disposed) return
      previewMime.value = file.mimeType
      previewBytes.value = file.data
      const format = resolvePreviewFormat(result.name, file.mimeType)
      const needsText = !format || format.views.includes("source") || format.views.some(v => v === "markdown" || v === "html" || v === "mermaid")
      const decoded = needsText ? decodeUtf8Text(file.data) : undefined
      if (decoded !== undefined) content.value = decoded
      if (!format && decoded === undefined) {
        error.value = t((canOpenResource.value || canRevealResource.value) ? "files.previewUnavailableLocal" : "files.previewUnavailable")
      }
    }
  } catch (reason) {
    if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    if (!disposed) loading.value = false
  }
}

async function runAction(task: () => Promise<unknown>): Promise<void> {
  try { await task() }
  catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason) }
}

async function fileAction(): Promise<void> {
  if (entry.value?.kind !== "file") return
  if (request && canOpenResource.value) return runAction(() => filesApi.value!.openResource!(request))
  if (request && !previewBytes.value) return runAction(() => filesApi.value?.saveResource(request) ?? Promise.resolve())
  if (!previewBytes.value) return
  downloadUrl.value ??= URL.createObjectURL(new Blob([new Uint8Array(previewBytes.value)], { type: previewMime.value }))
  const link = document.createElement("a")
  link.href = downloadUrl.value
  link.download = entry.value.name
  link.click()
}

function revealResource(): Promise<void> | undefined {
  if (request && entry.value?.kind === "file" && canRevealResource.value) return runAction(() => filesApi.value!.revealResource!(request))
}

function locateOriginal(): void {
  const pinia = getActivePinia()
  if (props.mode === "tab" && pinia) useLayoutStore(pinia).closeCompactPanel()
  void locatePreviewInMainView(uri, { ...props.source, sessionId: props.source?.sessionId ?? request?.sessionId, itemId: uri })
}

void open()
onBeforeUnmount(() => { disposed = true; if (downloadUrl.value) URL.revokeObjectURL(downloadUrl.value) })
</script>

<template>
  <div
    v-if="mode === 'tab'"
    data-resource-viewer
    data-resource-viewer-mode="tab"
    :data-resource-uri="uri"
    class="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-ui-surface text-ui-text"
  >
    <PreviewViewer
      v-if="fileReady"
      mode="tab"
      :title="displayTitle"
      :data="previewBytes"
      :text="content"
      :mime-type="previewMime"
      :filename="entry?.name"
      :base-path="entry?.path"
      :requested-lines="requestedLines"
      :source="{ ...source, sessionId: source?.sessionId ?? request?.sessionId, itemId: uri }"
      :resource-request="request"
      :api="filesApi"
      :can-open="entry?.canOpen"
      class="h-full flex-1 rounded-none border-0"
    />
    <template v-else>
      <PreviewToolbar
        mode="tab"
        :title="displayTitle"
        :title-tooltip="entry?.path ?? uri"
        :can-locate-message="true"
        :can-reveal="hasFileActions && canRevealResource"
        :can-open="hasFileActions && canOpenResource"
        :can-download="hasPrimaryAction && !canOpenResource"
        @locate-message="locateOriginal"
        @reveal="revealResource"
        @open="fileAction"
        @download="fileAction"
      />
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
        <UiScrollArea v-else-if="entry?.kind === 'directory' && filesApi && request" orientation="both" class="min-h-0 flex-1" viewport-class="p-4">
          <FileBrowserPane :api="filesApi" :target="request.target" :name="entry.name" :initial-path="entry.path" :revision="0" :reset-key="0" :selection="[]" :selectable="false" />
        </UiScrollArea>
        <div v-if="error" class="flex flex-col items-start gap-3 p-4">
          <p class="m-0 break-words text-sm text-ui-danger" role="alert">{{ error }}</p>
          <div v-if="hasFileActions" data-preview-error-actions class="flex flex-wrap items-center gap-2">
            <UiButton v-if="canRevealResource" type="button" data-preview-action="reveal" @click="revealResource"><FolderOpen :size="15" aria-hidden="true" />{{ revealLabel }}</UiButton>
            <UiButton v-if="hasPrimaryAction" type="button" :data-preview-action="canOpenResource ? 'open' : 'download'" @click="fileAction"><component :is="canOpenResource ? ExternalLink : Download" :size="15" aria-hidden="true" />{{ primaryActionLabel }}</UiButton>
          </div>
        </div>
      </div>
    </template>
  </div>
  <UiDialog v-else v-slot="{ close }" class="w-[48rem] max-w-[calc(100vw-2rem)]" @close="emit('close')">
    <DialogTitle class="ui-dialog-title mb-3 break-all">{{ entry?.name ?? uri }}</DialogTitle>
    <div v-if="loading" class="flex flex-col gap-2 text-sm text-ui-text-muted" role="status">
      <div class="flex items-center justify-between gap-2">
        <span>{{ t('folderPicker.loading') }}</span>
        <span v-if="loadPercent !== undefined" class="text-xs tabular-nums">{{ loadPercent }}%</span>
      </div>
      <div v-if="loadPercent !== undefined" class="h-1 w-full overflow-hidden rounded-full bg-ui-hover" role="progressbar" :aria-valuenow="loadPercent" aria-valuemin="0" aria-valuemax="100">
        <div class="h-full bg-ui-accent" v-spring.enter="{ width: `${loadPercent}%` }" />
      </div>
    </div>
    <FileBrowserPane v-else-if="entry?.kind === 'directory' && filesApi && request" :api="filesApi" :target="request.target" :name="entry.name" :initial-path="entry.path" :revision="0" :reset-key="0" :selection="[]" :selectable="false" />
    <PreviewViewer
      v-else-if="fileReady"
      mode="dialog"
      :title="displayTitle"
      :data="previewBytes"
      :text="content"
      :mime-type="previewMime"
      :filename="entry?.name"
      :base-path="entry?.path"
      :requested-lines="requestedLines"
      :resource-request="request"
      :api="filesApi"
      :can-open="entry?.canOpen"
    />
    <p v-if="error" class="break-words text-sm text-ui-danger" role="alert">{{ error }}</p>
    <div class="mt-4 flex justify-end gap-2">
      <UiButton v-if="hasFileActions && canRevealResource" type="button" data-preview-action="reveal" @click="revealResource">{{ revealLabel }}</UiButton>
      <UiButton v-if="hasPrimaryAction" type="button" :data-preview-action="canOpenResource ? 'open' : 'download'" @click="fileAction">{{ primaryActionLabel }}</UiButton>
      <UiButton type="button" @click="close">{{ t('files.close') }}</UiButton>
    </div>
  </UiDialog>
</template>
