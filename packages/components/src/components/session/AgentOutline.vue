<script lang="ts">
import type { AgentEvent, AgentInput, AgentSnapshot } from "@deskfleet/protocol/agent"
import type { ConversationEntry } from "../../services/agent-conversation.ts"

interface OutlineItem {
  id: string
  label: string
  reply?: string
}

const PREVIEW_ITEMS: OutlineItem[] = [
  { id: "preview-1", label: "Inspect repo", reply: "Scanned workspace packages and build scripts." },
  { id: "preview-2", label: "Check build configuration", reply: "Verified Vite and TypeScript settings across packages." },
  { id: "preview-3", label: "Run unit tests across workspace", reply: "All 42 test suites passed with zero warnings." },
  { id: "preview-4", label: "Fix lint warnings", reply: "Cleaned up unused imports and formatting." },
  { id: "preview-5", label: "Update appearance schema and defaults", reply: "Added outlineAudio, outlineAudioRgb, maxWidth, and decayMs fields." },
  { id: "preview-6", label: "Add audio loopback capture", reply: "Connected Web Audio AnalyserNode to system loopback stream." },
  { id: "preview-7", label: "Tune FFT bands and perceptual tilt", reply: "Mapped 24 logarithmic bands with +2 dB/oct tilt and Stevens power law." },
  { id: "preview-8", label: "Smooth attack and release envelope for outline bars", reply: "Applied fast attack and configurable exponential decay envelope." },
  { id: "preview-9", label: "Add live preview card in settings", reply: "Mounted AgentOutline inside the appearance preview container." },
  { id: "preview-10", label: "Enable RGB rainbow wave", reply: "Computed perceptually uniform OKLCH colors with @proj-airi/chromatic." },
  { id: "preview-11", label: "Check dark and light themes", reply: "Verified contrast and border tokens in both color schemes." },
  { id: "preview-12", label: "Verify TypeScript types", reply: "Ran vue-tsc with zero type errors." },
  { id: "preview-13", label: "Format locale files", reply: "Added translations for English, Simplified Chinese, and Japanese." },
  { id: "preview-14", label: "Clean up stories", reply: "Updated AgentOutline story in Storybook." },
  { id: "preview-15", label: "Ship it", reply: "Ready to merge." },
]
</script>

<script setup lang="ts">
import SpringSurface from "../common/SpringSurface.ts"
import { vSpring, vSpringEnter } from "../../directives/spring.ts"
import { useEventListener, useMediaQuery, useRafFn, watchImmediate } from "@vueuse/core"
import { TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from "reka-ui"
import { computed, ref, shallowRef, useTemplateRef, watch } from "vue"
import { useConversationProjection } from "../../composables/useConversationProjection.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { useScrollFade } from "../../composables/useScrollFade.ts"
import { useAppearanceStore } from "../../stores/appearance.ts"
import { OUTLINE_MIN_WIDTH, useOutlineAudioStore } from "../../stores/outline-audio.ts"

const SCRUB_WIDTH = 40
const EDGE_ZONE_PX = 28
const EDGE_SPEED_PX_S = 480

const props = withDefaults(defineProps<{
  /** Preview overrides; omitted values use the saved appearance. */
  preview?: boolean
  rgb?: boolean
  maxWidth?: number
  decayMs?: number
  active?: string
  entries?: OutlineItem[]
  events?: AgentEvent[]
  snapshot?: AgentSnapshot
  projection?: ConversationEntry[]
}>(), {
  preview: false,
  rgb: undefined,
})
const emit = defineEmits<{ select: [id: string] }>()

const client = usePlatformClient()
const appearance = useAppearanceStore()
const audio = useOutlineAudioStore()
const touch = useMediaQuery("(max-width: 1023.9px), (hover: none)")
const rows = useTemplateRef<HTMLLIElement[]>("rows")
const list = useTemplateRef<HTMLElement>("list")
const hovered = ref<string>()
const scrub = shallowRef<{ pointerId: number; item: OutlineItem; x: number; y: number }>()
const selectedPreview = ref(PREVIEW_ITEMS[7]!.id)
const audioEnabled = computed(() => props.preview || appearance.settings.outlineAudio)
const maxWidth = computed(() => props.maxWidth ?? appearance.settings.outlineAudioMaxWidth)
const baseWidth = computed(() => Math.max(32, audioEnabled.value ? maxWidth.value : 32))
const rgb = computed(() => props.rgb ?? (audioEnabled.value && appearance.settings.outlineAudioRgb))

watchImmediate(() => props.decayMs, value => { audio.decayOverride = value })

watchImmediate(() => props.preview, (isPreview, _, onCleanup) => {
  if (isPreview) onCleanup(audio.startPreview())
})

// The incremental projection retains completed content arrays. Their labels do
// not need to be flattened again when an unrelated thought token arrives.
const labels = new WeakMap<AgentInput["content"], string>()
function plainText(content: AgentInput["content"]): string {
  const cached = labels.get(content)
  if (cached !== undefined) return cached
  const parts: string[] = []
  for (const block of content) {
    if (block.type === "text") parts.push(block.text)
    else if (block.type === "resource" && "text" in block.resource) parts.push(block.resource.text)
  }
  const text = parts.join(" ").replace(/\s+/gu, " ").trim()
  labels.set(content, text)
  return text
}

const projection = useConversationProjection(() => props.events ?? [], () => props.snapshot)
const hasConversation = computed(() => props.entries !== undefined || props.projection !== undefined || !!(props.events && props.snapshot))
const items = computed<OutlineItem[]>(previous => {
  if (props.entries) return props.entries
  if (!hasConversation.value) return PREVIEW_ITEMS
  const result: OutlineItem[] = []
  for (const entry of props.projection ?? projection.value) {
    if (entry.kind === "input") {
      result.push({ id: entry.id, label: plainText(entry.input.content) })
      continue
    }
    if (entry.kind === "message" && entry.role === "assistant" && result.length) {
      const reply = plainText(entry.content)
      if (reply) result.at(-1)!.reply = reply
    }
  }
  return previous?.length === result.length && result.every((item, index) => {
    const before = previous[index]!
    return before.id === item.id && before.label === item.label && before.reply === item.reply
  }) ? previous : result
})

const currentActive = computed(() => props.active || (!hasConversation.value ? selectedPreview.value : undefined))
const pointedId = computed(() => scrub.value?.item.id ?? hovered.value)
const pointedIndex = computed(() => items.value.findIndex(item => item.id === pointedId.value))
const activeId = computed(() => scrub.value?.item.id ?? currentActive.value)

function tickWidth(index: number, label: string): number {
  const baseline = OUTLINE_MIN_WIDTH + (22 * label.length) / (label.length + 10)
  if (pointedIndex.value < 0) {
    return audioEnabled.value ? audio.width(index, items.value.length, baseline, maxWidth.value) : baseline
  }
  const distance = Math.abs(index - pointedIndex.value)
  if (scrub.value) {
    return distance <= 3 ? Math.max(baseline, SCRUB_WIDTH - distance * 7) : baseline
  }
  return distance <= 3 ? 32 - distance * 5 : baseline
}

function onSelect(id: string): void {
  if (!hasConversation.value) selectedPreview.value = id
  emit("select", id)
}

let lastY = 0
let touchPress = false

function scrubAt(clientY: number, initialPointerId?: number): boolean {
  const pointerId = initialPointerId ?? scrub.value?.pointerId
  const el = list.value
  const listItems = items.value
  const total = listItems.length
  if (pointerId === undefined || !el || !total) return false
  const rect = el.getBoundingClientRect()
  if (rect.height <= 0) return false
  const rowH = (el.scrollHeight || rect.height) / total
  const localY = Math.max(0, Math.min(rect.height - 0.01, clientY - rect.top))
  const index = Math.max(0, Math.min(total - 1, Math.floor((el.scrollTop + localY) / rowH)))
  const item = listItems[index]
  if (!item) return false
  const x = Math.round(rect.left + Math.max(SCRUB_WIDTH, baseWidth.value) + 10)
  const y = Math.round(Math.max(rect.top, Math.min(rect.bottom, rect.top + (index + 0.5) * rowH - el.scrollTop)))
  const initial = initialPointerId !== undefined
  const changed = initial || scrub.value?.item.id !== item.id
  scrub.value = { pointerId, item, x, y }
  if (changed) {
    client.haptic?.(initial ? "activate" : "tick")
    onSelect(item.id)
  }
  return true
}

function edgeSpeed(clientY: number, el: HTMLElement): number {
  const maxScroll = el.scrollHeight - el.clientHeight
  if (maxScroll <= 0) return 0
  const rect = el.getBoundingClientRect()
  if (clientY < rect.top + EDGE_ZONE_PX && el.scrollTop > 0) {
    return -Math.min(1.5, (rect.top + EDGE_ZONE_PX - clientY) / EDGE_ZONE_PX) * EDGE_SPEED_PX_S
  }
  if (clientY > rect.bottom - EDGE_ZONE_PX && el.scrollTop < maxScroll) {
    return Math.min(1.5, (clientY - rect.bottom + EDGE_ZONE_PX) / EDGE_ZONE_PX) * EDGE_SPEED_PX_S
  }
  return 0
}

const edgeScroll = useRafFn(({ delta }) => {
  const el = list.value
  const speed = scrub.value && el ? edgeSpeed(lastY, el) : 0
  if (!el || speed === 0) {
    edgeScroll.pause()
    return
  }
  el.scrollTop = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + speed * Math.min(delta, 50) / 1000))
  scrubAt(lastY)
}, { immediate: false })

function stopScrub(event?: PointerEvent): void {
  const active = scrub.value
  if (!active || (event && event.pointerId !== active.pointerId)) return
  edgeScroll.pause()
  scrub.value = undefined
  if (event?.type !== "lostpointercapture" && list.value?.hasPointerCapture?.(active.pointerId)) {
    list.value.releasePointerCapture(active.pointerId)
  }
}

function onPointerDown(event: PointerEvent): void {
  touchPress = event.pointerType !== "mouse"
  if (!touchPress) return
  stopScrub()
  if (!event.isPrimary) return
  event.stopPropagation()
  lastY = event.clientY
  if (!scrubAt(event.clientY, event.pointerId)) return
  const el = list.value!
  el.setPointerCapture?.(event.pointerId)
  if (edgeSpeed(event.clientY, el) !== 0) edgeScroll.resume()
}

function onPointerMove(event: PointerEvent): void {
  if (event.pointerId !== scrub.value?.pointerId) return
  lastY = event.clientY
  event.stopPropagation()
  scrubAt(event.clientY)
  const el = list.value
  if (el && edgeSpeed(event.clientY, el) !== 0) edgeScroll.resume()
  else edgeScroll.pause()
}

useEventListener(list, "touchmove", event => {
  if (scrub.value && event.cancelable) event.preventDefault()
}, { passive: false })

const { fadeStyle } = useScrollFade(list, { size: "sm" })

watch(currentActive, id => {
  if (scrub.value) return
  const index = items.value.findIndex(item => item.id === id)
  const row = rows.value?.[index]
  const scroller = list.value
  if (!row || !scroller) return
  // The list is the rows' offset parent. Leave enclosing scroll areas undisturbed.
  const top = row.offsetTop
  const bottom = top + row.offsetHeight
  if (top < scroller.scrollTop) scroller.scrollTop = top
  else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight
}, { flush: "post" })
</script>

<template>
  <nav
    v-if="items.length"
    :style="{ width: `${scrub ? Math.max(SCRUB_WIDTH, baseWidth) : baseWidth}px` }"
    class="pointer-events-none flex max-h-full max-w-[calc(100%-0.5rem)] flex-col"
  >
    <TooltipProvider :delay-duration="250" :disabled="touch || !!scrub">
      <div class="ui-scroll-mask flex min-h-0 flex-col" :style="fadeStyle">
        <ol
          ref="list"
          class="ui-outline-list pointer-events-auto relative min-h-0 select-none overflow-x-hidden overflow-y-auto scrollbar-none"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="stopScrub"
          @pointercancel="stopScrub"
          @lostpointercapture="stopScrub"
          @contextmenu="touchPress && $event.preventDefault()"
        >
        <li v-for="(item, index) in items" :key="item.id" ref="rows">
          <TooltipRoot>
            <TooltipTrigger
              type="button"
              :aria-label="item.label"
              :aria-current="currentActive === item.id ? 'location' : undefined"
              class="group pointer-events-auto flex h-2 cursor-pointer items-center rounded-sm"
              :class="scrub ? 'w-10' : 'w-8'"
              @pointerenter="$event.pointerType === 'mouse' && (hovered = item.id)"
              @pointerleave="$event.pointerType === 'mouse' && (hovered = undefined)"
              @click="(!$event.detail || !touchPress) && onSelect(item.id)"
            >
              <span
                aria-hidden="true"
                v-spring="{ width: `${tickWidth(index, item.label)}px` }"
                :style="{ backgroundColor: rgb ? audio.color(index, activeId === item.id) : undefined }"
                class="pointer-events-none shrink-0 rounded-full duration-150 ease-out"
                :class="[
                  'transition-[height,background-color]',
                  scrub && activeId === item.id ? 'h-[3px]' : 'h-0.5',
                  activeId === item.id ? 'bg-ui-accent' : 'bg-ui-text-muted/45 group-hover:bg-ui-text-muted group-focus-visible:bg-ui-text-muted',
                ]"
              />
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent :as="SpringSurface"
                side="right"
                :side-offset="8"
                :collision-padding="8"
                class="ui-tooltip z-70 max-w-72 break-words rounded-md border border-ui-border bg-ui-surface px-2.5 py-1.5 text-xs leading-5 text-ui-text shadow-ui-popover"
              >
                <p class="m-0 truncate font-medium">{{ item.label }}</p>
                <p
                  v-if="item.reply"
                  class="m-0 mt-1.5 line-clamp-3 text-ui-text-muted"
                >
                  {{ item.reply }}
                </p>
              </TooltipContent>
            </TooltipPortal>
          </TooltipRoot>
        </li>
        </ol>
      </div>
    </TooltipProvider>
    <Teleport to="body">
      <div
        v-if="scrub"
        v-spring-enter="'anchor'"
        data-side="right"
        data-outline-scrub-preview
        role="status"
        aria-live="polite"
        :style="{ left: `${scrub.x}px`, '--scrub-y': `${scrub.y}px` }"
        class="ui-outline-scrub-preview pointer-events-none fixed z-70 max-w-[min(18rem,calc(100vw-4.5rem))] -translate-y-1/2 break-words rounded-md border border-ui-border bg-ui-surface px-2.5 py-1.5 text-xs leading-5 text-ui-text shadow-ui-popover"
      >
        <p class="m-0 truncate font-medium">{{ scrub.item.label }}</p>
        <p v-if="scrub.item.reply" class="m-0 mt-1.5 line-clamp-3 text-ui-text-muted">
          {{ scrub.item.reply }}
        </p>
      </div>
    </Teleport>
  </nav>
</template>

<style scoped>
.ui-outline-list,
.ui-outline-list :deep(*) {
  touch-action: none;
}

.ui-outline-scrub-preview {
  top: clamp(2.5rem, var(--scrub-y), calc(100dvh - 2.5rem));
}
</style>
