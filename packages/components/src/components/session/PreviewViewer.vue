<script setup lang="ts">
import { Pipette } from "@lucide/vue"
import { watchImmediate } from "@vueuse/core"
import { getActivePinia } from "pinia"
import { computed, defineAsyncComponent, inject, onBeforeUnmount, provide, ref, shallowRef, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { FileResourceRequest } from "../../../../client/src/files.ts"
import { useFileTarget } from "../../composables/useFileTarget.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { router } from "../../router/index.ts"
import { agentResourceContextKey, isFileResource, type AgentResourceContext } from "../../services/agent-resources.ts"
import {
  previewKindFromMime,
  registerPreviewActionsKey,
  resolvePreviewKind,
  type PreviewKind,
  type PreviewMode,
  type PreviewSource,
  type PreviewToolbarAction,
} from "../../services/preview.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import {
  broadcastPreviewLocate,
  broadcastPreviewTab,
  focusPreview,
  locatePreviewInMainView,
  openPreviewFromAction,
} from "../../stores/previews.ts"
import ColorPickerLoupe from "./ColorPickerLoupe.vue"
import ImagePreview from "./ImagePreview.vue"
import MermaidViewer from "./MermaidViewer.vue"
import PreviewToolbar from "./PreviewToolbar.vue"

const ModelPreview = defineAsyncComponent(() => import("./ModelPreview.vue"))

const props = withDefaults(defineProps<{
  kind?: PreviewKind
  content: string
  data?: Uint8Array
  title?: string
  alt?: string
  mimeType?: string
  mode?: PreviewMode
  source?: PreviewSource
  resourceRequest?: FileResourceRequest
  loading?: boolean
}>(), {
  mode: "inline",
  loading: false,
})

const { t } = useI18n()
const client = usePlatformClient()
const layout = getActivePinia() ? useLayoutStore() : undefined
const root = useTemplateRef<HTMLElement>("root")
const video = useTemplateRef<HTMLVideoElement>("video")
const injectedContext = inject(agentResourceContextKey, computed(() => undefined))
const sessionId = computed(() => {
  if (props.source?.sessionId) return props.source.sessionId
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

const isDirectUrl = computed(() => /^(?:data:|blob:|https?:\/\/)/iu.test(props.content))
const isLocalResource = computed(() => !isDirectUrl.value && isFileResource(props.content))
const loadedUrl = ref<string>()
const loadedBytes = shallowRef<Uint8Array>()
const loadedMime = ref<string>()
const loadError = ref<string>()
const registeredActions = shallowRef<PreviewToolbarAction[]>([])
const pickingVideoColor = ref(false)
let loadGeneration = 0
let disposed = false

provide(registerPreviewActionsKey, actions => {
  registeredActions.value = actions
})

const kind = computed<PreviewKind>(() =>
  resolvePreviewKind(props.content, props.kind, loadedMime.value ?? props.mimeType),
)
const toolbarActions = computed<PreviewToolbarAction[]>(() =>
  kind.value === "video"
    ? [{ id: "color-picker", icon: Pipette, label: t("mermaid.pickColor"), onClick: () => { pickingVideoColor.value = !pickingVideoColor.value } }]
    : registeredActions.value,
)
const url = computed(() => isLocalResource.value ? loadedUrl.value : props.content)
const request = computed<FileResourceRequest | undefined>(() => {
  if (props.resourceRequest) {
    return { ...props.resourceRequest, target: { ...props.resourceRequest.target } }
  }
  return isLocalResource.value && resourceContext.value
    ? { ...resourceContext.value, target: { ...resourceContext.value.target }, uri: props.content }
    : undefined
})
const title = computed(() => props.title || (kind.value === "image" ? t("agent.image") : t("agent.contentType", { type: kind.value })))
const rightTabLabel = computed(() => t(layout?.compact && layout.sessionWindowsAvailable ? "mobileViews.open" : "mermaid.showInRightTab"))

function clearLoadedUrl(): void {
  if (loadedUrl.value) URL.revokeObjectURL(loadedUrl.value)
  loadedUrl.value = undefined
  loadedBytes.value = undefined
  loadedMime.value = undefined
}

function loadResource(): void {
  const version = ++loadGeneration
  clearLoadedUrl()
  loadError.value = undefined
  if (kind.value === "mermaid" || !isLocalResource.value) return
  if (!client.files || !request.value) {
    loadError.value = t("files.resourceUnavailable")
    return
  }
  void client.files.readResource(request.value).then(result => {
    if (disposed || version !== loadGeneration) return
    const resultKind = previewKindFromMime(result.mimeType)
    if (!resultKind) throw new Error(t("files.previewUnavailable"))
    loadedMime.value = result.mimeType
    loadedBytes.value = result.data
    loadedUrl.value = URL.createObjectURL(new Blob([new Uint8Array(result.data)], { type: result.mimeType }))
  }).catch(reason => {
    if (!disposed && version === loadGeneration) loadError.value = reason instanceof Error ? reason.message : String(reason)
  })
}

watchImmediate([() => props.content, () => props.kind, resourceContext], loadResource)

function previewSource(): PreviewSource {
  const host = root.value?.closest<HTMLElement>("[data-preview]")
  const entryId = props.source?.entryId ?? host?.closest<HTMLElement>("[data-conversation-entry]")?.dataset.conversationEntry
  const itemId = props.source?.itemId ?? host?.dataset.preview
  return {
    ...(sessionId.value ? { sessionId: sessionId.value } : {}),
    ...(entryId ? { entryId } : {}),
    ...(itemId ? { itemId } : {}),
  }
}

function descriptor() {
  const hostUri = root.value?.closest<HTMLElement>("[data-preview]")?.dataset.preview
  const localSourceContent = props.resourceRequest?.uri
    ?? (isLocalResource.value ? props.content : (kind.value === "model" && hostUri && isFileResource(hostUri) ? hostUri : undefined))
  return {
    kind: kind.value,
    content: localSourceContent ?? url.value ?? props.content,
    ...(props.title ? { title: props.title } : {}),
    ...(loadedMime.value || props.mimeType ? { mimeType: loadedMime.value ?? props.mimeType } : {}),
    source: previewSource(),
  }
}

function showFocused(): void {
  void focusPreview(descriptor())
}

function showInRightTab(): void {
  const item = descriptor()
  if (props.mode === "window") {
    broadcastPreviewTab(item)
    window.opener?.focus?.()
    return
  }
  openPreviewFromAction(item)
}

function showInNewWindow(): void {
  const item = descriptor()
  const params = new URLSearchParams({ content: item.content, kind: item.kind })
  if (item.title) params.set("title", item.title)
  if (item.mimeType) params.set("mimeType", item.mimeType)
  if (item.source?.sessionId) params.set("sessionId", item.source.sessionId)
  if (item.source?.entryId) params.set("entryId", item.source.entryId)
  if (item.source?.itemId) params.set("itemId", item.source.itemId)
  window.open(`${window.location.origin}${window.location.pathname}#/preview?${params.toString()}`, "_blank", "popup,width=960,height=680")
}

function locateOriginal(): void {
  const resolvedSource = previewSource()
  const targetContent = props.resourceRequest?.uri ?? props.content
  if (props.mode === "tab") layout?.closeCompactPanel()
  if (props.mode === "window") {
    broadcastPreviewLocate(targetContent, resolvedSource)
    window.opener?.focus?.()
    return
  }
  void locatePreviewInMainView(targetContent, resolvedSource)
}

function download(): void {
  if (client.files && request.value) void client.files.saveResource(request.value)
}

onBeforeUnmount(() => {
  disposed = true
  ++loadGeneration
  clearLoadedUrl()
})
</script>

<template>
  <MermaidViewer v-if="kind === 'mermaid'" :code="content" :mode="mode" :source="props.source" :loading="loading" />
  <div
    v-else
    ref="root"
    :data-preview-window-view="mode === 'window' ? '' : undefined"
    :data-preview-mode="mode"
    :data-preview-content="content"
    :data-preview-kind="kind"
    class="ui-preview relative flex flex-col overflow-hidden bg-ui-surface text-ui-text"
    :class="mode === 'window' ? 'h-full bg-ui-canvas' : mode === 'inline' ? 'rounded-xl border border-ui-border' : 'min-h-0 flex-1 rounded-xl border border-ui-border'"
  >
    <header v-if="mode === 'window'" class="app-drag titlebar-overlay-inset flex h-12 shrink-0 items-center border-b border-ui-border pr-4" :class="client.platform === 'darwin' ? 'pl-20' : 'pl-4'">
      <h1 class="m-0 truncate text-sm font-medium">{{ title }}</h1>
    </header>
    <div v-if="url" class="relative flex min-h-0 flex-1 flex-col">
      <PreviewToolbar
        :mode="mode"
        :actions="toolbarActions"
        :can-download="Boolean(request && client.files)"
        :right-tab-label="rightTabLabel"
        @focus="showFocused"
        @download="download"
        @show-in-right-tab="showInRightTab"
        @show-in-new-window="showInNewWindow"
        @locate-message="locateOriginal"
      />
      <ImagePreview
        v-if="kind === 'image'"
        :src="url"
        :alt="alt || title"
        :mode="mode"
        @focus="showFocused"
      />
      <ModelPreview
        v-else-if="kind === 'model'"
        :src="url"
        :data="loadedBytes ?? props.data"
        :mime-type="loadedMime ?? props.mimeType"
        :filename="isLocalResource ? props.content : (props.title || props.content)"
        :mode="mode"
      />
      <div
        v-else
        data-preview-canvas
        class="relative flex flex-1 items-center justify-center overflow-hidden p-4 pt-11"
        :class="[mode === 'inline' && kind === 'audio' ? 'min-h-24' : 'min-h-44', kind === 'video' && pickingVideoColor && 'cursor-crosshair select-none']"
      >
        <div data-preview-stage class="flex h-full w-full items-center justify-center">
          <audio v-if="kind === 'audio'" :src="url" controls preload="metadata" class="w-full max-w-md" />
          <video v-else ref="video" :src="url" controls preload="metadata" playsinline class="max-h-full max-w-full rounded object-contain" :class="[mode === 'inline' && 'max-h-96', pickingVideoColor && 'pointer-events-none']" />
        </div>
        <ColorPickerLoupe v-if="kind === 'video'" v-model:open="pickingVideoColor" :media="video" />
      </div>
    </div>
    <div v-else class="flex items-center gap-2 p-3 text-sm text-ui-text-muted">
      <button v-if="loadError" type="button" class="ui-button" :title="`${loadError} — ${t('files.retry')}`" @click="loadResource">{{ alt || title || loadError }}</button>
      <span v-else>{{ t("files.loadingResource") }}</span>
    </div>
  </div>
</template>
