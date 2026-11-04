<script setup lang="ts">
import { Grid3x3, Plus, SquareTerminal, X } from "@lucide/vue"
import { useElementSize, usePreferredReducedMotion } from "@vueuse/core"
import { computed, defineAsyncComponent, nextTick, onScopeDispose, provide, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { truncateGeneratedTitle } from "../../../../../apps/daemon/src/titles.ts"
import { useSessionLabel } from "../../composables/useSessionLabel.ts"
import { useMobileViewportSwipe } from "../../composables/useMobileViewportSwipe.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { pendingMermaidLocate, useLayoutStore, type SessionWindowRequest } from "../../stores/layout.ts"
import { pendingPreviewLocate } from "../../stores/previews.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import ErrorNotice from "../common/ErrorNotice.vue"
import IconButton from "../common/IconButton.vue"
import ChangesPanel from "../details/ChangesPanel.vue"
import SessionPreviewWindow from "../session/SessionPreviewWindow.vue"
import WindowToolbar from "./WindowToolbar.vue"
import MobileViewFrame from "./MobileViewFrame.vue"
import { windowHeaderActionsId, windowHeaderActionsTarget, windowHeaderActionsTargetKey } from "./windowHeaderActions.ts"

type MobileView =
  | { id: string; title: string; kind: "chat" | "changes" }
  | { id: string; title: string; kind: "terminal"; terminalId: string }
  | { id: string; title: string; kind: "preview"; request: SessionWindowRequest }

const props = defineProps<{ sessionId: string }>()
const { t } = useI18n()
const fleet = useFleetStore()
const layout = useLayoutStore()
const terminals = useTerminalsStore()
const sessionLabel = useSessionLabel()
const SessionView = defineAsyncComponent(() => import("../../views/SessionView.vue"))
const TerminalShellWindow = defineAsyncComponent(() => import("../terminal/TerminalShellWindow.vue"))
const location = computed(() => fleet.findSession(props.sessionId))
const worktree = computed(() => location.value?.worktree)
const previews = ref<Extract<MobileView, { kind: "preview" }>[]>([])
const activeId = ref("chat")
const visited = ref(new Set(["chat"]))
const overviewOpen = ref(false)
const busy = ref(false)
const error = ref<string>()
const headerId = computed(() => windowHeaderActionsId(`mobile-${props.sessionId}`))
provide(windowHeaderActionsTargetKey, computed(() => windowHeaderActionsTarget(`mobile-${props.sessionId}`)))

const views = computed<MobileView[]>(() => [
  { id: "chat", kind: "chat", title: location.value ? sessionLabel(location.value.session) : t("panel.chat") },
  { id: "changes", kind: "changes", title: t("panel.changes") },
  ...terminals.sessions.filter(shell => worktree.value && shell.worktreeId === worktree.value.id && shell.kind !== "acp").map((shell, index) => ({
    id: `terminal:${shell.id}`, kind: "terminal" as const, terminalId: shell.id,
    title: terminals.titles[shell.id]?.trim() || shell.title.trim() || t("terminal.tab", { number: index + 1 }),
  })),
  ...previews.value,
])
const activeIndex = computed(() => Math.max(0, views.value.findIndex(view => view.id === activeId.value)))
const activeView = computed(() => views.value[activeIndex.value]!)

function reveal(index: number): void {
  const view = views.value[index]
  // Peeking at a terminal must not initialize its renderer or attach to its shell.
  if (view && view.kind !== "terminal") visited.value.add(view.id)
}
function select(index: number): void {
  const view = views.value[index]
  if (!view) return
  visited.value.add(view.id)
  if (overviewOpen.value || zooming.value) void transitionOverview(false, view.id)
  else activeId.value = view.id
}
function selectId(id: string): void { select(views.value.findIndex(view => view.id === id)) }

watch(views, next => {
  if (!next.some(view => view.id === activeId.value)) { activeId.value = "chat"; reveal(0) }
})
watch(() => layout.sidebarOpen, open => { if (open && overviewOpen.value) void transitionOverview(false) })
watch(() => layout.detailsOpen, open => {
  if (open) { layout.closeCompactPanel(); selectId("changes") }
})
watch(() => layout.sessionWindowRequest, request => {
  if (!request) return
  const title = request.kind === "mermaid" ? t("mermaid.title")
    : request.kind === "resource" ? (request.item.title || request.item.request.uri.replace(/[?#].*$/u, "").split(/[\\/]/u).filter(Boolean).at(-1) || request.item.request.uri)
    : request.item.title || (request.item.kind === "image" ? t("agent.image") : t("agent.contentType", { type: request.item.kind }))
  const id = `preview:${request.id}`
  previews.value.push({ id, kind: "preview", title, request })
  selectId(id)
})
watch([pendingPreviewLocate, pendingMermaidLocate], requests => {
  if (requests.some(request => request && (!request.sessionId || request.sessionId === props.sessionId))) selectId("chat")
}, { flush: "sync" })

if (!terminals.loaded) void terminals.refresh()
async function newTerminal(): Promise<void> {
  if (!worktree.value || busy.value) return
  busy.value = true
  error.value = undefined
  try {
    const shell = await terminals.create({ worktreeId: worktree.value.id })
    selectId(`terminal:${shell.id}`)
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
async function closeView(view: MobileView): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = undefined
  try {
    if (view.kind === "terminal") await terminals.hangup(view.terminalId)
    else if (view.kind === "preview") previews.value = previews.value.filter(preview => preview.id !== view.id)
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
function toggleOverview(event: MouseEvent): void {
  layout.closeCompactPanel()
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus()
  void transitionOverview(!overviewOpen.value)
}

const viewport = useTemplateRef<HTMLElement>("viewport")
const scroller = useTemplateRef<HTMLElement>("scroller")
const stage = useTemplateRef<HTMLElement>("stage")
const { width: viewportWidth, height: viewportHeight } = useElementSize(viewport)
const reducedMotion = usePreferredReducedMotion()
const zooming = ref(false)
const cardWidth = computed(() => Math.max(0, (viewportWidth.value - 56) / 3))
const cardScale = computed(() => viewportWidth.value > 0 ? cardWidth.value / viewportWidth.value : 1)
const rowHeight = computed(() => viewportHeight.value * cardScale.value + 52)
const gridHeight = computed(() => Math.ceil(views.value.length / 3) * rowHeight.value + 16)
let animations: Animation[] = []
let transitionId = 0
onScopeDispose(() => { transitionId++; for (const animation of animations) animation.cancel() })

// Animate the actual live surfaces between their screen positions. Their layout
// dimensions and DOM parents stay fixed, including when the overview is scrolled.
async function transitionOverview(open: boolean, selectedId = activeId.value): Promise<void> {
  const id = ++transitionId
  const surfaces = [...stage.value?.querySelectorAll<HTMLElement>("[data-view-surface]") ?? []]
  const previous = new Map(surfaces.map(element => [element, {
    rect: element.getBoundingClientRect(), radius: getComputedStyle(element).borderRadius,
  }]))
  for (const animation of animations) animation.cancel()
  animations = []
  zooming.value = true
  if (!open && document.activeElement && stage.value?.contains(document.activeElement)) {
    viewport.value?.parentElement?.querySelector<HTMLButtonElement>("[data-open-overview]")?.focus({ preventScroll: true })
  }
  if (open) views.value.forEach((_, index) => reveal(index))
  activeId.value = selectedId
  overviewOpen.value = open
  await nextTick()
  if (id !== transitionId || !stage.value || !scroller.value) return
  scroller.value.scrollTop = open ? Math.floor(activeIndex.value / 3) * rowHeight.value : 0
  const origin = stage.value.getBoundingClientRect()
  if (reducedMotion.value !== "reduce" && viewportWidth.value > 0) {
    for (const [element, { rect, radius }] of previous) {
      if (!element.isConnected || rect.width === 0) continue
      animations.push(element.animate([
        { transform: `translate(${rect.left - origin.left}px, ${rect.top - origin.top}px) scale(${rect.width / viewportWidth.value})`, borderRadius: radius },
        { transform: element.style.transform, borderRadius: getComputedStyle(element).borderRadius },
      ], { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }))
    }
  }
  await Promise.all(animations.map(animation => animation.finished.catch(() => {})))
  if (id === transitionId) { zooming.value = false; animations = [] }
}
function dismissOverview(): void {
  if (overviewOpen.value) {
    void transitionOverview(false)
    viewport.value?.parentElement?.querySelector<HTMLButtonElement>("[data-open-overview]")?.focus({ preventScroll: true })
  }
}
const { offset, dragging, settling } = useMobileViewportSwipe({
  viewport,
  index: () => activeIndex.value,
  count: () => views.value.length,
  enabled: () => !overviewOpen.value && !zooming.value && !layout.sidebarOpen,
  reducedMotion: () => reducedMotion.value === "reduce",
  select, reveal,
})
</script>

<template>
  <main data-mobile-windows class="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-ui-canvas" @keydown.esc="dismissOverview">
    <header class="flex h-12 shrink-0 items-center gap-2 px-3">
      <WindowToolbar :history="false" />
      <h1 class="m-0 min-w-0 flex-1 truncate text-sm font-medium">{{ overviewOpen ? t('mobileViews.overview') : activeView.title }}</h1>
      <div :id="headerId" v-show="activeId === 'chat' && !overviewOpen" />
      <IconButton :icon="overviewOpen ? X : Grid3x3" :label="overviewOpen ? t('common.close') : t('mobileViews.overview')" :aria-expanded="overviewOpen" data-open-overview @click="toggleOverview" />
    </header>
    <ErrorNotice v-if="error" :error="error" />
    <div ref="viewport" data-mobile-viewport class="relative min-h-0 flex-1 overflow-hidden" :class="{ dragging: dragging || settling, zooming }">
      <div ref="scroller" class="absolute inset-0 overscroll-contain" :class="overviewOpen ? 'overflow-x-hidden overflow-y-auto' : 'overflow-clip'" :data-view-overview="overviewOpen ? '' : undefined">
        <div ref="stage" class="relative w-full" :style="{ height: `${overviewOpen ? gridHeight + (worktree ? 64 : 0) : viewportHeight}px`, transform: `translate3d(${offset}px, 0, 0)` }">
          <MobileViewFrame v-for="(view, index) in views" :key="view.id" :data-mobile-view="view.id" :aria-hidden="!overviewOpen && view.id !== activeId" :title="view.title" :active="view.id === activeId" :preview="overviewOpen" :source-width="viewportWidth" :source-height="viewportHeight" :x="overviewOpen ? 16 + (index % 3) * (cardWidth + 12) : (index - activeIndex) * viewportWidth" :y="overviewOpen ? 48 + Math.floor(index / 3) * rowHeight : 0" :scale="overviewOpen ? cardScale : 1" :closable="view.kind === 'terminal' || view.kind === 'preview'" :busy="busy" @select="select(index)" @close="closeView(view)">
            <template v-if="visited.has(view.id)">
              <SessionView v-if="view.kind === 'chat'" :session-id="sessionId" />
              <ChangesPanel v-else-if="view.kind === 'changes'" windowed standalone />
              <TerminalShellWindow v-else-if="view.kind === 'terminal'" :terminal-id="view.terminalId" @title="terminals.titles[view.terminalId] = truncateGeneratedTitle($event)" />
              <SessionPreviewWindow v-else-if="view.kind === 'preview'" :request="view.request" />
            </template>
            <div v-else-if="view.kind === 'terminal'" data-unopened-terminal class="flex h-full flex-col items-center justify-center gap-6 px-8 text-center text-ui-text-muted">
              <SquareTerminal :size="80" :stroke-width="1.25" aria-hidden="true" />
              <span class="text-4xl">{{ t('mobileViews.openTerminal') }}</span>
            </div>
          </MobileViewFrame>
          <button v-if="overviewOpen && worktree" type="button" :disabled="busy" class="absolute inset-x-4 flex h-11 items-center justify-center gap-2 rounded-xl border border-ui-border text-sm text-ui-text-muted hover:bg-ui-hover disabled:op-40" :style="{ top: `${gridHeight}px` }" @click="newTerminal">
            <Plus :size="18" aria-hidden="true" />{{ t('terminal.new') }}
          </button>
        </div>
      </div>
    </div>
  </main>
</template>
