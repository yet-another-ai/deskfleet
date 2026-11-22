<script setup lang="ts">
import { ArrowDown } from "@lucide/vue"
import { useElementSize, useResizeObserver, useScroll, watchImmediate } from "@vueuse/core"
import { computed, nextTick, onBeforeUnmount, onScopeDispose, provide, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useRoute } from "vue-router"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { conversationReadingKey, useConversationReadingStore } from "../../stores/conversation-reading.ts"
import { pendingMermaidLocate, performMermaidLocateDom, useLayoutStore, type MermaidSource } from "../../stores/layout.ts"
import { focusedPreviewFromRoute, pendingPreviewLocate, performPreviewLocateDom } from "../../stores/previews.ts"
import { scrollSpring, type SpringScroll } from "../../services/spring-scroll.ts"
import FocusOverlay from "../common/FocusOverlay.vue"
import UiButton from "../common/UiButton.vue"
import UiScrollArea from "../common/UiScrollArea.vue"
import WindowToolbar from "../chrome/WindowToolbar.vue"
import MermaidViewer from "./MermaidViewer.vue"
import PreviewViewer from "./PreviewViewer.vue"
import ReadingSpotlight from "./ReadingSpotlight.vue"

const props = withDefaults(defineProps<{
  /** Reading progress is scoped to the owner of the conversation. */
  readingId: string
  /** Used by preview navigation for machine Sessions. */
  sessionId?: string
  loading?: boolean
  ready?: boolean
  revision?: unknown
  showComposer?: boolean
  composerActive?: boolean
  sidebar?: boolean
}>(), { sidebar: true })
const { t } = useI18n()
const route = useRoute()
const { platform } = usePlatformClient()
const layout = useLayoutStore()
const toolbarLeftInset = computed(() => platform === "darwin" && !layout.sidebarOpen ? "pl-20" : "pl-2")
const reading = useConversationReadingStore()
provide(conversationReadingKey, () => reading.session(props.readingId))
const scrollArea = useTemplateRef<InstanceType<typeof UiScrollArea>>("scrollArea")
const scroller = computed(() => scrollArea.value?.viewportElement ?? undefined)
const content = useTemplateRef<HTMLElement>("content")
const overlay = useTemplateRef<HTMLElement>("overlay")
const { height: overlayHeight } = useElementSize(overlay, { width: 0, height: 140 }, { box: "border-box" })
const followBottom = ref(true)
const activeEntry = ref<string>()
const focusedEntry = computed(() => typeof route.query.entry === "string" && route.query.entry ? route.query.entry : undefined)
const focusedMermaid = computed(() => typeof route.query.mermaid === "string" && route.query.mermaid ? route.query.mermaid : undefined)
const mermaidSource = computed<MermaidSource>(() => ({
  ...(props.sessionId ? { sessionId: props.sessionId } : {}),
  ...(typeof route.query.mermaidEntry === "string" && route.query.mermaidEntry ? { entryId: route.query.mermaidEntry } : {}),
  ...(typeof route.query.mermaidDiagram === "string" && route.query.mermaidDiagram ? { diagramId: route.query.mermaidDiagram } : {}),
}))
const mermaidContent = computed(() => focusedMermaid.value ? { code: focusedMermaid.value, source: mermaidSource.value } : undefined)
const focusedPreview = computed(() => {
  const preview = focusedPreviewFromRoute(route)
  if (!preview) return undefined
  return props.sessionId ? { ...preview, source: { sessionId: props.sessionId, ...preview.source } } : preview
})
const pendingLocate = computed(() => pendingPreviewLocate.value ?? pendingMermaidLocate.value)
let locatedEntry: string | undefined
let entryHighlightTimer: ReturnType<typeof setTimeout> | undefined
let restoringScroll = false
let followingSpring: SpringScroll | undefined
onScopeDispose(() => {
  clearTimeout(entryHighlightTimer)
  followingSpring?.cancel()
  followingSpring = undefined
})

function saveReading(id: string): void {
  if (scroller.value?.isConnected && !restoringScroll) reading.session(id).scroll = { top: scroller.value.scrollTop, bottom: followBottom.value }
}
onBeforeUnmount(() => saveReading(props.readingId))
const { arrivedState } = useScroll(scroller, {
  offset: { bottom: 100 },
  onScroll() {
    if (restoringScroll || followingSpring) return
    followBottom.value = arrivedState.bottom
    saveReading(props.readingId)
    updateOutline()
  },
})

function followSpringToBottom(el: HTMLElement): void {
  const spring = scrollSpring(el, el.scrollHeight)
  followingSpring = spring
  void spring.finished.then(completed => {
    if (followingSpring !== spring) return
    followingSpring = undefined
    if (!completed && el.isConnected) followBottom.value = arrivedState.bottom
    saveReading(props.readingId)
    updateOutline()
  })
}

function scrollToBottom(): void {
  followBottom.value = true
  saveReading(props.readingId)
  if (scroller.value) followSpringToBottom(scroller.value)
}

function outlineEntries(): HTMLElement[] {
  return [...scroller.value?.querySelectorAll<HTMLElement>("li.ui-conversation-input[data-conversation-entry]") ?? []]
}

function updateOutline(): void {
  const el = scroller.value
  const entries = outlineEntries()
  if (!el || !entries.length) return
  const threshold = el.getBoundingClientRect().top + 80
  const current = followBottom.value ? entries.at(-1) : entries.findLast(item => item.getBoundingClientRect().top <= threshold) ?? entries[0]
  activeEntry.value = current?.dataset.conversationEntry
}

function locateEntry(id: string): void {
  const target = outlineEntries().find(item => item.dataset.conversationEntry === id)
  if (!target) return
  followBottom.value = false
  target.scrollIntoView({ block: "start", behavior: "instant" })
  activeEntry.value = id
}

function restoreReading() {
  if (!restoringScroll || props.loading || !scroller.value) return
  if (!focusedEntry.value && !pendingLocate.value) {
    const saved = reading.session(props.readingId).scroll
    scroller.value.scrollTo({ top: !saved || saved.bottom ? scroller.value.scrollHeight : saved.top })
  }
  restoringScroll = false
  updateOutline()
}

watchImmediate(() => props.readingId, (id, previous) => {
  if (previous) saveReading(previous)
  followingSpring?.cancel()
  followingSpring = undefined
  restoringScroll = true
  activeEntry.value = undefined
  locatedEntry = undefined
  followBottom.value = !focusedEntry.value && (!pendingLocate.value || (!!pendingLocate.value.sessionId && pendingLocate.value.sessionId !== props.sessionId))
  const saved = reading.session(id).scroll
  if (saved && !focusedEntry.value && !pendingLocate.value) followBottom.value = saved.bottom
  void nextTick(() => { if (props.readingId === id) restoreReading() })
})
function followLatest() {
  const el = scroller.value
  if (!el || restoringScroll || props.loading || !followBottom.value || pendingLocate.value) return
  if (followingSpring) followSpringToBottom(el)
  else el.scrollTo({ top: el.scrollHeight })
}
// Realizing history rows and loading their media can resize the transcript between revisions.
useResizeObserver(content, followLatest)
watch([() => props.revision, () => props.loading], () => {
  if (restoringScroll) restoreReading()
  else followLatest()
  if (followBottom.value || !activeEntry.value) updateOutline()
}, { flush: "post" })
watch([focusedEntry, () => props.readingId, () => props.loading, () => props.revision], async ([entry, id, loading]) => {
  if (!entry) { locatedEntry = undefined; return }
  const key = `${id}:${entry}`
  if (locatedEntry === key) return
  followBottom.value = false
  if (loading) return
  await nextTick()
  if (props.readingId !== id || focusedEntry.value !== entry) return
  const target = [...scroller.value?.querySelectorAll<HTMLElement>("[data-conversation-entry]") ?? []].find(item => item.dataset.conversationEntry === entry)
  if (!target) return
  locatedEntry = key
  clearTimeout(entryHighlightTimer)
  for (const previous of scroller.value?.querySelectorAll<HTMLElement>("[data-conversation-located]") ?? []) delete previous.dataset.conversationLocated
  target.dataset.conversationLocated = "true"
  target.scrollIntoView({ block: "center", behavior: "instant" })
  entryHighlightTimer = setTimeout(() => { delete target.dataset.conversationLocated }, 2000)
}, { immediate: true, flush: "post" })
watch([pendingLocate, () => props.loading, () => props.revision, focusedPreview, focusedMermaid], async ([target, loading, , preview, mermaid]) => {
  if (!target || loading || preview || mermaid) return
  if (target.sessionId && target.sessionId !== props.sessionId) return
  followBottom.value = false
  await nextTick()
  if ("content" in target) performPreviewLocateDom(target)
  else performMermaidLocateDom(target)
}, { flush: "post" })
</script>

<template>
  <div class="relative flex min-h-0 min-w-0 flex-1">
    <UiScrollArea
      ref="scrollArea"
      fade="top"
      class="min-h-0 min-w-0 flex-1"
      content-class="flex min-h-full flex-col"
      data-session-scroll-area
      :viewport-attrs="{ 'data-session-scroll-viewport': '' }"
    >
      <div ref="content" class="mx-auto flex min-h-full w-full max-w-3xl flex-1 flex-col px-6 pt-6" :style="{ paddingBottom: `${overlayHeight + 24}px` }">
        <slot :focused-entry="focusedEntry" />
      </div>
    </UiScrollArea>
    <ReadingSpotlight />
    <slot v-if="!loading" name="outline" :active-entry="activeEntry" :locate-entry="locateEntry" />
    <div v-if="ready && !loading && !followBottom" class="pointer-events-none absolute inset-x-0 z-20 flex justify-center" :style="{ bottom: `${overlayHeight + 8}px` }">
      <div class="relative mx-auto flex w-full max-w-3xl justify-end px-6">
        <UiButton type="button" size="icon" class="pointer-events-auto h-8 w-8 rounded-full border border-ui-border bg-ui-surface text-ui-text shadow-ui-popover" :label="t('agent.scrollToBottom')" data-scroll-to-bottom @click="scrollToBottom">
          <ArrowDown :size="16" :stroke-width="1.75" aria-hidden="true" />
        </UiButton>
      </div>
    </div>
    <div v-if="showComposer" ref="overlay" class="pointer-events-none absolute inset-x-0 bottom-0 z-10">
      <div class="pointer-events-auto relative mx-auto flex w-full max-w-3xl flex-col bg-ui-canvas">
        <div aria-hidden="true" class="pointer-events-none absolute inset-x-0 -top-6 h-6 [background:linear-gradient(to_bottom,transparent,var(--ui-color-canvas))]" />
        <div class="flex w-full shrink-0 flex-col gap-2 px-6 empty:hidden" :class="composerActive ? 'pb-2' : 'pb-5'">
          <slot name="notices" />
        </div>
        <slot name="composer" />
      </div>
    </div>
    <FocusOverlay :content="mermaidContent" data-mermaid-focus-view class="absolute inset-0 z-20 flex flex-col bg-ui-canvas" @after-leave="performMermaidLocateDom()" v-slot="{ content }">
      <div class="app-drag flex h-9 shrink-0 items-center pr-[var(--window-controls-width,0px)]" :class="toolbarLeftInset"><WindowToolbar :sidebar="sidebar" /></div>
      <MermaidViewer :key="content.code" :code="content.code" :source="content.source" mode="focus" class="min-h-0 flex-1 rounded-none border-0" />
    </FocusOverlay>
    <FocusOverlay :content="focusedPreview" data-preview-focus-view class="absolute inset-0 z-20 flex flex-col bg-ui-canvas" @after-leave="performPreviewLocateDom()" v-slot="{ content }">
      <div class="app-drag flex h-9 shrink-0 items-center pr-[var(--window-controls-width,0px)]" :class="toolbarLeftInset"><WindowToolbar :sidebar="sidebar" /></div>
      <PreviewViewer :key="content.content" v-bind="content" mode="focus" class="min-h-0 flex-1 rounded-none border-0" />
    </FocusOverlay>
  </div>
</template>
