<script setup lang="ts">
import { Pipette } from "@lucide/vue"
import { watchImmediate } from "@vueuse/core"
import { getActivePinia } from "pinia"
import { computed, defineAsyncComponent, inject, onBeforeUnmount, provide, ref, shallowRef, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { FileResourceRequest, FilesApi } from "@deskfleet/client/files"
import { useFileTarget } from "../../composables/useFileTarget.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { router } from "../../router/index.ts"
import { agentResourceContextKey, isFileResource, type AgentResourceContext } from "../../services/agent-resources.ts"
import {
  conversationEntryIdKey,
  decodeDataUrlText,
  decodeUtf8Text,
  previewDefaultTitle,
  previewKindFromUri,
  previewResourceRequestToQuery,
  registerPreviewActionsKey,
  resolveAvailableViews,
  resolveInitialView,
  resolvePreviewFormat,
  type PreviewDescriptor,
  type PreviewKind,
  type PreviewMode,
  type PreviewSource,
  type PreviewToolbarAction,
  type PreviewView,
} from "../../services/preview.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import { broadcastPreviewLocate, broadcastPreviewTab, focusPreview, locatePreviewInMainView, usePreviewActions } from "../../stores/previews.ts"
import UiScrollArea from "../common/UiScrollArea.vue"
import CodeSourcePreview from "./CodeSourcePreview.vue"
import ColorPickerLoupe from "./ColorPickerLoupe.vue"
import CsvPreview from "./CsvPreview.vue"
import ImagePreview from "./ImagePreview.vue"
import MermaidPreview from "./MermaidPreview.vue"
import PreviewToolbar from "./PreviewToolbar.vue"

const AgentMarkdown = defineAsyncComponent(() => import("./AgentMarkdown.vue"))
const ModelPreview = defineAsyncComponent(() => import("./ModelPreview.vue"))
const OfficePreview = defineAsyncComponent(() => import("./OfficePreview.vue"))
const URL_VIEWS = new Set<PreviewView>(["image", "audio", "video", "model", "docx", "xlsx", "pptx"])

const props = withDefaults(defineProps<{
  kind?: PreviewKind
  /** Resource URL or file path; omit for inline text or raw byte previews. */
  content?: string
  data?: Uint8Array
  /** Inline text payload (e.g. Mermaid source or decoded file text). */
  text?: string
  title?: string
  alt?: string
  mimeType?: string
  filename?: string
  basePath?: string
  requestedLines?: { start: number; end: number }
  mode?: PreviewMode
  source?: PreviewSource
  resourceRequest?: FileResourceRequest
  api?: FilesApi
  canOpen?: boolean
  loading?: boolean
  /** Inline callers wrapping PreviewViewer in a persistent anchor pass false to avoid duplicate [data-preview] markers. */
  locateAnchor?: boolean
}>(), {
  mode: "inline",
  loading: false,
  locateAnchor: true,
})

const { t } = useI18n()
const client = usePlatformClient()
const filesApi = computed(() => props.api ?? client.files)
const layout = getActivePinia() ? useLayoutStore() : undefined
const { openPreviewFromAction } = usePreviewActions()
const video = useTemplateRef<HTMLVideoElement>("video")
const injectedEntryId = inject(conversationEntryIdKey, computed(() => undefined))
const injectedContext = inject(agentResourceContextKey, computed(() => undefined))
const sessionId = computed(() => {
  if (props.source?.sessionId) return props.source.sessionId
  if (props.resourceRequest?.sessionId) return props.resourceRequest.sessionId
  if (injectedContext.value?.sessionId) return injectedContext.value.sessionId
  const route = router.currentRoute.value
  return route.name === "session" && typeof route.params.sessionId === "string" ? route.params.sessionId : undefined
})
const fallbackTarget = useFileTarget(computed(() => {
  if (injectedContext.value || !getActivePinia()) return undefined
  const fleet = useFleetStore()
  return sessionId.value ? fleet.findSession(sessionId.value)?.machine.id : fleet.newSessionTarget?.machine.id
}))
const resourceContext = computed<AgentResourceContext | undefined>(() =>
  injectedContext.value ?? (fallbackTarget.value ? { target: fallbackTarget.value, sessionId: sessionId.value ?? "" } : undefined),
)

const isDirectUrl = computed(() => Boolean(props.content && /^(?:data:|blob:|https?:\/\/)/iu.test(props.content)))
const isLocalResource = computed(() => !props.data && props.text === undefined && Boolean(props.content) && !isDirectUrl.value && isFileResource(props.content!))
const loadedUrl = ref<string>()
const generatedBlobUrl = ref<string>()
const loadedBytes = shallowRef<Uint8Array>()
const loadedMime = ref<string>()
const loadedName = ref<string>()
const loadedCanOpen = ref<boolean>()
const loadError = ref<string>()
const actionError = ref<string>()
const registeredActions = shallowRef<PreviewToolbarAction[]>([])
const pickingVideoColor = ref(false)
let htmlPreviewSent = false
let loadGeneration = 0
let disposed = false

provide(registerPreviewActionsKey, actions => { registeredActions.value = actions })

const resolvedName = computed(() => loadedName.value ?? props.filename)
const resolvedMime = computed(() => loadedMime.value ?? props.mimeType)
const format = computed(() =>
  resolvePreviewFormat(resolvedName.value ?? props.content ?? props.title ?? "", resolvedMime.value, props.kind)
  ?? (isDirectUrl.value ? resolvePreviewFormat("", undefined, "image") : undefined),
)
const kind = computed<PreviewKind | undefined>(() =>
  format.value ? (format.value.mediaKind ?? format.value.id) as PreviewKind : props.kind,
)
const activeBytes = computed(() => loadedBytes.value ?? props.data)
const sourceText = computed(() => {
  if (props.text !== undefined) return props.text
  if (!format.value?.views.includes("source")) return undefined
  return activeBytes.value ? decodeUtf8Text(activeBytes.value) : (props.content ? decodeDataUrlText(props.content) : undefined)
})
const availableViews = computed(() => resolveAvailableViews(format.value, sourceText.value !== undefined))
const activeView = ref<PreviewView>(resolveInitialView(availableViews.value, Boolean(props.requestedLines)))

function ensureBlobUrl(): string | undefined {
  if (props.content) return props.content
  if (generatedBlobUrl.value) return generatedBlobUrl.value
  if (!activeBytes.value) return undefined
  generatedBlobUrl.value = URL.createObjectURL(new Blob([new Uint8Array(activeBytes.value)], { type: resolvedMime.value }))
  return generatedBlobUrl.value
}

watch([() => props.content, () => props.text, () => props.kind, () => props.filename, format], () => {
  htmlPreviewSent = false
  activeView.value = resolveInitialView(availableViews.value, Boolean(props.requestedLines))
})
watch(availableViews, views => {
  if (!views.includes(activeView.value)) activeView.value = resolveInitialView(views, Boolean(props.requestedLines))
})
watch(activeView, view => {
  htmlPreviewSent = false
  if (URL_VIEWS.has(view) && !isLocalResource.value) ensureBlobUrl()
}, { immediate: true })
watch(() => activeView.value === "video", (isVideo, wasVideo) => {
  if (!isVideo && wasVideo) { pickingVideoColor.value = false; registeredActions.value = [] }
})
watch([() => activeView.value === "video", pickingVideoColor], ([isVideo, picking]) => {
  if (!isVideo) return
  registeredActions.value = [{ id: "color-picker", icon: Pipette, label: t("mermaid.pickColor"), pressed: picking, onClick: () => { pickingVideoColor.value = !pickingVideoColor.value } }]
}, { immediate: true, flush: "post" })

const url = computed(() => isLocalResource.value ? loadedUrl.value : (props.content || generatedBlobUrl.value))
const ready = computed(() => Boolean(url.value) || sourceText.value !== undefined || activeBytes.value !== undefined)
const request = computed<FileResourceRequest | undefined>(() => {
  if (props.resourceRequest) return { ...props.resourceRequest, target: { ...props.resourceRequest.target } }
  return isLocalResource.value && resourceContext.value && props.content
    ? { ...resourceContext.value, target: { ...resourceContext.value.target }, uri: props.content }
    : undefined
})
const isLocalFile = computed(() => Boolean((loadedCanOpen.value ?? props.canOpen) && request.value))
const canOpenResource = computed(() => Boolean(isLocalFile.value && filesApi.value?.openResource))
const canRevealResource = computed(() => Boolean(isLocalFile.value && filesApi.value?.revealResource))
const canShowInNewWindow = computed(() => Boolean(ready.value && (format.value?.mediaKind || (kind.value && !request.value))))
const canDownload = computed(() => Boolean(url.value || activeBytes.value))
const title = computed(() => props.title || resolvedName.value || previewDefaultTitle(kind.value, t))
const filename = computed(() =>
  resolvedName.value
  ?? (isLocalResource.value ? props.content : props.title)
  ?? (format.value?.extensions?.[0] ? `preview.${format.value.extensions[0]}` : props.content),
)
const rightTabLabel = computed(() => t(layout?.compact && layout.sessionWindowsAvailable ? "mobileViews.open" : "mermaid.showInRightTab"))
const compact = computed(() => props.mode === "inline" || props.mode === "dialog")

function clearLoadedUrl(): void {
  if (loadedUrl.value) URL.revokeObjectURL(loadedUrl.value)
  loadedUrl.value = undefined
  loadedBytes.value = undefined
  loadedMime.value = undefined
  loadedName.value = undefined
  loadedCanOpen.value = undefined
}

function loadResource(): void {
  const version = ++loadGeneration
  clearLoadedUrl()
  loadError.value = undefined
  actionError.value = undefined
  if (!isLocalResource.value) return
  if (!filesApi.value || !request.value) { loadError.value = t("files.resourceUnavailable"); return }
  void filesApi.value.readResource(request.value).then(result => {
    if (disposed || version !== loadGeneration) return
    if (!previewKindFromUri(result.name, result.mimeType)) throw new Error(t("files.previewUnavailable"))
    loadedName.value = result.name
    loadedCanOpen.value = result.canOpen
    loadedMime.value = result.mimeType
    loadedBytes.value = result.data
    loadedUrl.value = URL.createObjectURL(new Blob([new Uint8Array(result.data)], { type: result.mimeType }))
  }).catch(reason => {
    if (!disposed && version === loadGeneration) loadError.value = reason instanceof Error ? reason.message : String(reason)
  })
}
watchImmediate([() => props.content, () => props.kind, request, filesApi], loadResource)

function resolvedSource(): PreviewSource {
  return {
    sessionId: sessionId.value,
    entryId: props.source?.entryId ?? injectedEntryId.value,
    itemId: props.source?.itemId,
  }
}

function descriptor(): PreviewDescriptor {
  const resolvedKind = (format.value?.mediaKind ?? kind.value ?? "image") as PreviewKind
  const localSourceContent = props.resourceRequest?.uri ?? (isLocalResource.value ? props.content : undefined)
  const resolvedContent = localSourceContent ?? url.value
  return {
    kind: resolvedKind,
    content: resolvedContent,
    text: resolvedContent ? undefined : sourceText.value,
    title: props.title || undefined,
    mimeType: resolvedMime.value,
    source: resolvedSource(),
    resourceRequest: request.value ? { ...request.value, target: { ...request.value.target } } : undefined,
  }
}

async function showFocused(): Promise<void> {
  await focusPreview(descriptor())
}

function showInRightTab(): void {
  const item = descriptor()
  if (props.mode === "window") { broadcastPreviewTab(item); window.opener?.focus?.(); return }
  openPreviewFromAction(item)
}

function showInNewWindow(): void {
  const item = descriptor()
  const params = new URLSearchParams({ kind: item.kind })
  if (item.content) params.set("content", item.content)
  if (item.text !== undefined) params.set("text", item.text)
  if (item.title) params.set("title", item.title)
  if (item.mimeType) params.set("mimeType", item.mimeType)
  if (item.source?.sessionId) params.set("sessionId", item.source.sessionId)
  if (item.source?.entryId) params.set("entryId", item.source.entryId)
  if (item.source?.itemId) params.set("itemId", item.source.itemId)
  for (const [key, value] of Object.entries(previewResourceRequestToQuery(item.resourceRequest))) {
    if (value !== undefined) params.set(key, value)
  }
  window.open(`${window.location.origin}${window.location.pathname}#/preview?${params.toString()}`, "_blank", "popup,width=960,height=680")
}

async function locateOriginal(): Promise<void> {
  if (props.mode === "tab") layout?.closeCompactPanel()
  const src = resolvedSource()
  const target = props.resourceRequest?.uri ?? props.content ?? props.text ?? ""
  if (props.mode === "window") {
    broadcastPreviewLocate(target, src)
    window.opener?.focus?.()
    if (window.location.hash.startsWith("#/preview")) return
  }
  await locatePreviewInMainView(target, src)
}

function download(): void {
  const href = url.value || ensureBlobUrl()
  if (!href) return
  const link = document.createElement("a")
  link.href = href
  link.download = resolvedName.value ?? title.value
  link.click()
}

async function runResourceAction(method: "openResource" | "revealResource"): Promise<void> {
  const handler = filesApi.value?.[method]
  if (!isLocalFile.value || !handler) return
  actionError.value = undefined
  try { await handler(request.value!) }
  catch (reason) { if (!disposed) actionError.value = reason instanceof Error ? reason.message : String(reason) }
}

function sendHtmlPreview(event: Event): void {
  if (htmlPreviewSent || sourceText.value === undefined) return
  const frame = event.currentTarget instanceof HTMLIFrameElement ? event.currentTarget : undefined
  if (!frame?.contentWindow) return
  htmlPreviewSent = true
  frame.contentWindow.postMessage({ html: sourceText.value }, "*")
}

onBeforeUnmount(() => {
  disposed = true
  ++loadGeneration
  clearLoadedUrl()
  if (generatedBlobUrl.value) URL.revokeObjectURL(generatedBlobUrl.value)
})
</script>

<template>
  <div
    :data-preview="mode === 'inline' && locateAnchor ? source?.itemId : undefined"
    :data-preview-window-view="mode === 'window' ? '' : undefined"
    :data-preview-mode="mode"
    :data-preview-content="content || text || undefined"
    :data-preview-kind="kind ?? 'source'"
    class="ui-preview relative flex flex-col overflow-hidden bg-ui-surface text-ui-text"
    :class="mode === 'window' ? 'h-full bg-ui-canvas' : mode === 'dialog' ? 'max-h-[60vh]' : mode === 'inline' ? 'rounded-xl border border-ui-border' : 'min-h-0 flex-1 rounded-xl border border-ui-border'"
  >
    <PreviewToolbar
      :mode="mode"
      :title="title"
      :title-tooltip="basePath ?? request?.uri ?? title"
      :actions="ready ? registeredActions : []"
      :views="ready ? availableViews : []"
      :active-view="activeView"
      :can-focus="ready"
      :can-download="canDownload"
      :can-open="Boolean(ready && canOpenResource)"
      :can-reveal="Boolean(ready && canRevealResource)"
      :can-show-in-right-tab="ready"
      :can-show-in-new-window="canShowInNewWindow"
      :can-locate-message="ready"
      :right-tab-label="rightTabLabel"
      @select-view="activeView = $event"
      @focus="showFocused"
      @download="download"
      @open="runResourceAction('openResource')"
      @reveal="runResourceAction('revealResource')"
      @show-in-right-tab="showInRightTab"
      @show-in-new-window="showInNewWindow"
      @locate-message="locateOriginal"
    />
    <div v-if="ready" class="relative flex min-h-0 flex-1 flex-col">
      <p v-if="actionError" role="alert" class="m-0 px-3 py-2 text-sm text-ui-danger">{{ actionError }}</p>
      <CodeSourcePreview v-if="activeView === 'source' && sourceText !== undefined" :content="sourceText" :filename="filename" :requested-lines="requestedLines" :compact="compact" />
      <iframe v-else-if="activeView === 'html' && sourceText !== undefined" data-html-preview src="./html-preview.html" sandbox="allow-scripts allow-forms" :title="title" class="w-full bg-white" :class="compact ? 'h-[60vh] rounded border border-ui-border' : 'min-h-0 flex-1 border-0'" @load="sendHtmlPreview" />
      <UiScrollArea v-else-if="activeView === 'markdown' && sourceText !== undefined" data-markdown-preview :fade-size="compact ? 'sm' : undefined" :class="compact ? 'max-h-[60vh]' : 'min-h-0 flex-1'" :viewport-class="compact ? undefined : 'p-4'">
        <AgentMarkdown :text="sourceText" :api="filesApi" :base-path="basePath" class="min-w-0 text-sm" />
      </UiScrollArea>
      <MermaidPreview v-else-if="activeView === 'mermaid' && sourceText !== undefined" :code="sourceText" :mode="mode" :loading="loading" />
      <ImagePreview v-else-if="activeView === 'image' && url" :src="url" :alt="alt || title" :mode="mode" @focus="showFocused" />
      <ModelPreview v-else-if="activeView === 'model' && (url || activeBytes)" :src="url ?? ''" :data="activeBytes" :mime-type="resolvedMime" :filename="filename" :mode="mode" />
      <OfficePreview v-else-if="(activeView === 'docx' || activeView === 'xlsx' || activeView === 'pptx') && (url || activeBytes)" :kind="activeView" :src="url ?? ''" :data="activeBytes" :mode="mode" />
      <CsvPreview v-else-if="activeView === 'csv' && (url || activeBytes)" :src="url ?? ''" :data="activeBytes" :mode="mode" :title="title" :local-actions="canOpenResource || canRevealResource" />
      <div v-else-if="(activeView === 'audio' || activeView === 'video') && url" data-preview-canvas class="relative flex flex-1 items-center justify-center overflow-hidden p-4" :class="[mode === 'inline' && activeView === 'audio' ? 'min-h-20' : 'min-h-44', activeView === 'video' && pickingVideoColor && 'cursor-crosshair select-none']">
        <div data-preview-stage class="flex h-full w-full items-center justify-center">
          <audio v-if="activeView === 'audio'" :src="url" controls preload="metadata" class="w-full max-w-md" />
          <video v-else ref="video" :src="url" controls preload="metadata" playsinline class="max-h-full max-w-full rounded object-contain" :class="[mode === 'inline' && 'max-h-96', pickingVideoColor && 'pointer-events-none']" />
        </div>
        <ColorPickerLoupe v-if="activeView === 'video'" v-model:open="pickingVideoColor" :media="video" />
      </div>
    </div>
    <div v-else class="flex items-center gap-2 p-3 text-sm text-ui-text-muted">
      <button v-if="loadError" type="button" class="ui-button" :title="`${loadError} — ${t('files.retry')}`" @click="loadResource">{{ alt || title || loadError }}</button>
      <span v-else>{{ t("files.loadingResource") }}</span>
    </div>
  </div>
</template>
