<script setup lang="ts">
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { Check, Copy, Ellipsis, ExternalLink, LocateFixed, Maximize2, PanelRight, RotateCcw, ZoomIn, ZoomOut } from "@lucide/vue"
import { watchImmediate } from "@vueuse/core"
import { getActivePinia, storeToRefs } from "pinia"
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from "reka-ui"
import { computed, inject, onBeforeUnmount, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import { router } from "../../router/index.ts"
import { agentResourceContextKey } from "../../services/agent-resources.ts"
import { renderMermaidDiagram } from "../../services/mermaid.ts"
import { useAppearanceStore } from "../../stores/appearance.ts"
import { broadcastMermaidLocate, locateMermaidInMainView, openMermaidSidebarTab, useLayoutStore, type MermaidSource } from "../../stores/layout.ts"
import IconButton from "../common/IconButton.vue"

const platformClient = usePlatformClient()

const props = withDefaults(defineProps<{ code: string; mode?: "inline" | "focus" | "sidebar" | "window"; source?: MermaidSource; loading?: boolean }>(), { mode: "inline", loading: false })
const { t } = useI18n()
const platform = platformClient.platform
const { isDark } = storeToRefs(useAppearanceStore())
const root = useTemplateRef<HTMLDivElement>("root")
const resourceContext = inject(agentResourceContextKey, computed(() => undefined))
const svg = ref<string>()
const scale = ref(1)
const panX = ref(0)
const panY = ref(0)
const dragging = ref(false)
const menuOpen = ref(false)
const copied = ref(false)
let dragStartX = 0, dragStartY = 0, generation = 0, disposed = false
let copiedTimer: ReturnType<typeof setTimeout> | undefined
let debounceTimer: ReturnType<typeof setTimeout> | undefined

function triggerRender(code: string, dark: boolean, isStreaming: boolean, version: number): void {
  const trimmed = code.trim()
  if (!trimmed) {
    svg.value = undefined
    return
  }
  void renderMermaidDiagram(trimmed, dark)
    .then(rendered => { if (!disposed && version === generation) svg.value = rendered })
    .catch(() => {
      // During streaming, keep the last valid SVG instead of flashing back to <pre><code> on incomplete syntax.
      if (!disposed && version === generation && !isStreaming) svg.value = undefined
    })
}

watchImmediate([() => props.code, isDark, () => props.loading], ([code, dark, isStreaming]) => {
  const version = ++generation
  clearTimeout(debounceTimer)
  if (!code.trim()) {
    svg.value = undefined
    return
  }
  if (isStreaming) {
    debounceTimer = setTimeout(() => {
      if (!disposed && version === generation) triggerRender(code, dark, true, version)
    }, 120)
  } else {
    triggerRender(code, dark, false, version)
  }
})

function resolvedSource(): MermaidSource {
  const route = router.currentRoute.value
  const sessionId = props.source?.sessionId ?? resourceContext.value?.sessionId ?? (route.name === "session" && typeof route.params.sessionId === "string" ? route.params.sessionId : undefined)
  const entryId = props.source?.entryId ?? root.value?.closest<HTMLElement>("[data-conversation-entry]")?.dataset.conversationEntry
  const diagramId = props.source?.diagramId ?? root.value?.dataset.mermaid
  return { ...(sessionId ? { sessionId } : {}), ...(entryId ? { entryId } : {}), ...(diagramId ? { diagramId } : {}) }
}

const zoomIn = () => { scale.value = Math.min(4, Math.round((scale.value + 0.25) * 100) / 100) }
const zoomOut = () => { scale.value = Math.max(0.25, Math.round((scale.value - 0.25) * 100) / 100) }
const resetView = () => { scale.value = 1; panX.value = 0; panY.value = 0 }
function startDrag(event: PointerEvent): void {
  if (event.button !== 0) return
  dragging.value = true; dragStartX = event.clientX - panX.value; dragStartY = event.clientY - panY.value
  ;(event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId)
}
function moveDrag(event: PointerEvent): void {
  if (dragging.value) { panX.value = event.clientX - dragStartX; panY.value = event.clientY - dragStartY }
}
function endDrag(event: PointerEvent): void {
  if (!dragging.value) return
  dragging.value = false
  ;(event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId)
}
function onWheel(event: WheelEvent): void {
  if (!event.ctrlKey && !event.metaKey && props.mode === "inline") return
  event.preventDefault()
  if (event.deltaY < 0) zoomIn(); else if (event.deltaY > 0) zoomOut()
}
async function focusDiagram(): Promise<void> {
  if (getActivePinia()) useLayoutStore().sidebarOpen = true
  const source = resolvedSource(), current = router.currentRoute.value
  await router.push({ path: current.path, query: { ...current.query, mermaid: props.code, mermaidEntry: source.entryId, mermaidDiagram: source.diagramId } })
}
async function copyCode(): Promise<void> {
  menuOpen.value = false
  try { await navigator.clipboard.writeText(props.code) } catch { return }
  clearTimeout(copiedTimer)
  copied.value = true
  copiedTimer = setTimeout(() => { if (!disposed) copied.value = false }, 1500)
}
function showInSidebar(): void {
  menuOpen.value = false
  const source = resolvedSource()
  if (getActivePinia()) useLayoutStore().openMermaidInSidebar(props.code, source)
  else openMermaidSidebarTab(props.code, source)
}
function showInNewWindow(): void {
  menuOpen.value = false
  const source = resolvedSource(), params = new URLSearchParams({ code: props.code })
  if (source.sessionId) params.set("sessionId", source.sessionId)
  if (source.entryId) params.set("entryId", source.entryId)
  if (source.diagramId) params.set("diagramId", source.diagramId)
  window.open(`${window.location.origin}${window.location.pathname}#/mermaid?${params.toString()}`, "_blank", "popup,width=960,height=680")
}
async function locateOriginalMessage(): Promise<void> {
  const source = resolvedSource()
  if (props.mode === "window") {
    broadcastMermaidLocate(props.code, source)
    window.opener?.focus?.()
    if (window.location.hash.startsWith("#/mermaid")) return
  }
  await locateMermaidInMainView(props.code, source)
}
onBeforeUnmount(() => { disposed = true; ++generation; clearTimeout(copiedTimer); clearTimeout(debounceTimer) })
</script>

<template>
  <div
    ref="root"
    :data-mermaid-window-view="mode === 'window' ? '' : undefined"
    :data-mermaid-mode="mode"
    :data-mermaid-code="code"
    class="ui-mermaid relative flex flex-col overflow-hidden bg-ui-surface text-ui-text"
    :class="mode === 'window' ? 'h-full bg-ui-canvas' : mode === 'inline' ? 'rounded-xl border border-ui-border' : 'min-h-0 flex-1 rounded-xl border border-ui-border'"
  >
    <header v-if="mode === 'window'" class="app-drag titlebar-overlay-inset flex h-12 shrink-0 items-center border-b border-ui-border pr-4" :class="platform === 'darwin' ? 'pl-20' : 'pl-4'">
      <h1 class="m-0 truncate text-sm font-medium">{{ t('mermaid.title') }}</h1>
    </header>
    <div v-if="svg" class="relative flex min-h-0 flex-1 flex-col">
      <div data-mermaid-toolbar class="app-no-drag absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded-lg border border-ui-border bg-ui-canvas/90 p-0.5 shadow-ui-card backdrop-blur-xs">
        <IconButton :icon="ZoomIn" :label="t('mermaid.zoomIn')" data-mermaid-action="zoom-in" @click="zoomIn" />
        <IconButton :icon="ZoomOut" :label="t('mermaid.zoomOut')" data-mermaid-action="zoom-out" @click="zoomOut" />
        <IconButton :icon="RotateCcw" :label="t('mermaid.resetView')" data-mermaid-action="reset" @click="resetView" />
        <IconButton v-if="mode === 'sidebar' || mode === 'window'" :icon="LocateFixed" :label="t('mermaid.locateMessage')" data-mermaid-action="locate-message" @click="locateOriginalMessage" />
        <IconButton v-if="mode !== 'focus' && mode !== 'window'" :icon="Maximize2" :label="t('mermaid.focus')" data-mermaid-action="focus" @click="focusDiagram" />
        <DropdownMenuRoot :open="menuOpen" :modal="false" @update:open="menuOpen = $event">
          <DropdownMenuTrigger :as="IconButton" :icon="Ellipsis" :label="t('mermaid.more')" data-mermaid-action="more" />
          <DropdownMenuPortal>
            <DropdownMenuContent align="end" :side-offset="4" :collision-padding="8" :aria-label="t('mermaid.more')" class="ui-menu z-50 flex w-44 flex-col" loop>
              <DropdownMenuItem as="button" type="button" class="ui-menu-item" data-mermaid-action="copy" @select="copyCode">
                <component :is="copied ? Check : Copy" :size="14" aria-hidden="true" />{{ t(copied ? 'common.copied' : 'common.copy') }}
              </DropdownMenuItem>
              <DropdownMenuItem v-if="mode !== 'sidebar' && mode !== 'window'" as="button" type="button" class="ui-menu-item" data-mermaid-action="show-in-sidebar" @select="showInSidebar">
                <PanelRight :size="14" aria-hidden="true" />{{ t('mermaid.showInSidebar') }}
              </DropdownMenuItem>
              <DropdownMenuItem v-if="mode !== 'window'" as="button" type="button" class="ui-menu-item" data-mermaid-action="show-in-new-window" @select="showInNewWindow">
                <ExternalLink :size="14" aria-hidden="true" />{{ t('mermaid.showInNewWindow') }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
      </div>
      <div
        data-mermaid-canvas
        class="flex min-h-44 flex-1 items-center justify-center overflow-hidden p-4 pt-11 select-none"
        :class="dragging ? 'cursor-grabbing' : 'cursor-grab'"
        @pointerdown="startDrag"
        @pointermove="moveDrag"
        @pointerup="endDrag"
        @pointercancel="endDrag"
        @wheel="onWheel"
      >
        <div data-mermaid-stage class="flex w-full items-center justify-center transition-transform duration-75 ease-out" :class="dragging && 'transition-none!'" :style="{ transform: `translate(${panX}px, ${panY}px) scale(${scale})` }" v-html="svg" />
      </div>
    </div>
    <pre v-else class="m-0 overflow-x-auto border-0 p-3"><code>{{ code }}</code></pre>
  </div>
</template>
