<script setup lang="ts">
import { Download, Ellipsis, ExternalLink, LocateFixed, Maximize2, PanelRight, ZoomIn, ZoomOut } from "@lucide/vue"
import { watchImmediate } from "@vueuse/core"
import { getActivePinia } from "pinia"
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from "reka-ui"
import { computed, inject, onBeforeUnmount, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { FileResourceRequest } from "../../../../client/src/files.ts"
import { useFileTarget } from "../../composables/useFileTarget.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { router } from "../../router/index.ts"
import { agentResourceContextKey, isFileResource, type AgentResourceContext } from "../../services/agent-resources.ts"
import { previewKindFromMime, resolvePreviewKind, type PreviewKind, type PreviewMode, type PreviewSource } from "../../services/preview.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import {
  broadcastPreviewLocate,
  broadcastPreviewSidebar,
  focusPreview,
  locatePreviewInMainView,
  openPreviewInSidebar,
} from "../../stores/previews.ts"
import IconButton from "../common/IconButton.vue"
import MermaidViewer from "./MermaidViewer.vue"

const props = withDefaults(defineProps<{
  kind?: PreviewKind
  content: string
  title?: string
  alt?: string
  mimeType?: string
  mode?: PreviewMode
  source?: PreviewSource
  loading?: boolean
}>(), {
  mode: "inline",
  loading: false,
})

const { t } = useI18n()
const client = usePlatformClient()
const layout = getActivePinia() ? useLayoutStore() : undefined
const root = useTemplateRef<HTMLElement>("root")
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
const loadedMime = ref<string>()
const loadError = ref<string>()
let loadGeneration = 0
let disposed = false

const kind = computed<PreviewKind>(() =>
  resolvePreviewKind(props.content, props.kind, loadedMime.value ?? props.mimeType),
)
const url = computed(() => isLocalResource.value ? loadedUrl.value : props.content)
const request = computed<FileResourceRequest | undefined>(() =>
  isLocalResource.value && resourceContext.value ? { ...resourceContext.value, uri: props.content } : undefined,
)
const pannable = computed(() => kind.value === "image")
const title = computed(() => props.title || (kind.value === "image" ? t("agent.image") : t("agent.contentType", { type: kind.value })))

function clearLoadedUrl(): void {
  if (loadedUrl.value) URL.revokeObjectURL(loadedUrl.value)
  loadedUrl.value = undefined
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
  return {
    kind: kind.value,
    content: url.value ?? props.content,
    ...(props.title ? { title: props.title } : {}),
    ...(loadedMime.value || props.mimeType ? { mimeType: loadedMime.value ?? props.mimeType } : {}),
    source: previewSource(),
  }
}

function showFocused(): void {
  void focusPreview(descriptor())
}

function showInSidebar(): void {
  menuOpen.value = false
  const item = descriptor()
  if (props.mode === "window") {
    broadcastPreviewSidebar(item)
    window.opener?.focus?.()
    return
  }
  openPreviewInSidebar(item)
}

function showInNewWindow(): void {
  menuOpen.value = false
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
  menuOpen.value = false
  const resolvedSource = previewSource()
  if (props.mode === "sidebar") layout?.closeCompactPanel()
  if (props.mode === "window") {
    broadcastPreviewLocate(props.content, resolvedSource)
    window.opener?.focus?.()
    return
  }
  void locatePreviewInMainView(props.content, resolvedSource)
}

function download(): void {
  menuOpen.value = false
  if (client.files && request.value) void client.files.saveResource(request.value)
}

const scale = ref(1)
const panX = ref(0)
const panY = ref(0)
const dragging = ref(false)
const moved = ref(false)
const menuOpen = ref(false)
let dragStartX = 0
let dragStartY = 0

const zoomIn = () => { scale.value = Math.min(4, scale.value + 0.25) }
const zoomOut = () => { scale.value = Math.max(0.25, scale.value - 0.25) }

function startDrag(event: PointerEvent): void {
  if (!pannable.value || event.button !== 0) return
  dragging.value = true
  moved.value = false
  dragStartX = event.clientX - panX.value
  dragStartY = event.clientY - panY.value
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function moveDrag(event: PointerEvent): void {
  if (!dragging.value) return
  const nextX = event.clientX - dragStartX
  const nextY = event.clientY - dragStartY
  if (Math.hypot(nextX - panX.value, nextY - panY.value) > 3) moved.value = true
  panX.value = nextX
  panY.value = nextY
}

function endDrag(event: PointerEvent): void {
  if (!dragging.value) return
  dragging.value = false
  ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
}

function onWheel(event: WheelEvent): void {
  if (!pannable.value || (!event.ctrlKey && !event.metaKey && props.mode === "inline")) return
  event.preventDefault()
  if (event.deltaY < 0) zoomIn()
  else if (event.deltaY > 0) zoomOut()
}

function focusImage(): void {
  if (props.mode === "inline" && !moved.value) showFocused()
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
      <div data-preview-toolbar class="app-no-drag absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded-lg border border-ui-border bg-ui-canvas/90 p-0.5 shadow-ui-card backdrop-blur-xs">
        <template v-if="pannable">
          <IconButton :icon="ZoomIn" :label="t('mermaid.zoomIn')" data-preview-action="zoom-in" @click="zoomIn" />
          <IconButton :icon="ZoomOut" :label="t('mermaid.zoomOut')" data-preview-action="zoom-out" @click="zoomOut" />
        </template>
        <IconButton v-if="mode === 'inline'" :icon="Maximize2" :label="t('mermaid.focus')" data-preview-action="focus" @click="showFocused" />
        <DropdownMenuRoot v-model:open="menuOpen" :modal="false">
          <DropdownMenuTrigger :as="IconButton" :icon="Ellipsis" :label="t('mermaid.more')" data-preview-action="more" />
          <DropdownMenuPortal>
            <DropdownMenuContent align="end" :side-offset="4" :collision-padding="8" :aria-label="t('mermaid.more')" class="ui-menu z-50 flex w-44 flex-col" loop>
              <DropdownMenuItem v-if="request && client.files" as="button" type="button" class="ui-menu-item" data-preview-action="download" @select="download">
                <Download :size="14" aria-hidden="true" />{{ t('files.downloadResource') }}
              </DropdownMenuItem>
              <DropdownMenuItem v-if="mode !== 'sidebar'" as="button" type="button" class="ui-menu-item" data-preview-action="show-in-sidebar" @select="showInSidebar">
                <PanelRight :size="14" aria-hidden="true" />{{ t('mermaid.showInSidebar') }}
              </DropdownMenuItem>
              <DropdownMenuItem v-if="mode !== 'window'" as="button" type="button" class="ui-menu-item" data-preview-action="show-in-new-window" @select="showInNewWindow">
                <ExternalLink :size="14" aria-hidden="true" />{{ t('mermaid.showInNewWindow') }}
              </DropdownMenuItem>
              <DropdownMenuItem v-if="mode !== 'inline'" as="button" type="button" class="ui-menu-item" data-preview-action="locate-message" @select="locateOriginal">
                <LocateFixed :size="14" aria-hidden="true" />{{ t('mermaid.locateMessage') }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
      </div>
      <div
        data-preview-canvas
        class="flex flex-1 items-center justify-center overflow-hidden p-4 pt-11"
        :class="pannable ? ['min-h-44 select-none', dragging ? 'cursor-grabbing' : 'cursor-grab'] : mode === 'inline' ? 'min-h-24' : 'min-h-44'"
        @pointerdown="startDrag"
        @pointermove="moveDrag"
        @pointerup="endDrag"
        @pointercancel="endDrag"
        @wheel="onWheel"
      >
        <div
          data-preview-stage
          class="flex h-full w-full items-center justify-center transition-transform duration-75 ease-out"
          :class="dragging && 'transition-none!'"
          :style="pannable ? { transform: `translate(${panX}px, ${panY}px) scale(${scale})` } : undefined"
        >
          <img v-if="kind === 'image'" :src="url" :alt="alt || title" draggable="false" class="max-h-full max-w-full rounded object-contain select-none" :class="mode === 'inline' && 'max-h-96 cursor-zoom-in'" @click="focusImage">
          <audio v-else-if="kind === 'audio'" :src="url" controls preload="metadata" class="w-full max-w-md" />
          <video v-else :src="url" controls preload="metadata" playsinline class="max-h-full max-w-full rounded object-contain" :class="mode === 'inline' && 'max-h-96'" />
        </div>
      </div>
    </div>
    <div v-else class="flex items-center gap-2 p-3 text-sm text-ui-text-muted">
      <button v-if="loadError" type="button" class="ui-button" :title="`${loadError} — ${t('files.retry')}`" @click="loadResource">{{ alt || title || loadError }}</button>
      <span v-else>{{ t("files.loadingResource") }}</span>
    </div>
  </div>
</template>
