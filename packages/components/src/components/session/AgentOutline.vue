<script lang="ts">
import type { AgentEvent, AgentInput, AgentSnapshot } from "../../../../../apps/daemon/src/agent-protocol.ts"
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
import { watchImmediate } from "@vueuse/core"
import { TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from "reka-ui"
import { computed, ref, useTemplateRef, watch } from "vue"
import { useConversationProjection } from "../../composables/useConversationProjection.ts"
import { useScrollFade } from "../../composables/useScrollFade.ts"
import { useAppearanceStore } from "../../stores/appearance.ts"
import { OUTLINE_MIN_WIDTH, useOutlineAudioStore } from "../../stores/outline-audio.ts"

const props = withDefaults(defineProps<{
  /** Preview overrides; omitted values use the saved appearance. */
  preview?: boolean
  rgb?: boolean
  maxWidth?: number
  decayMs?: number
  active?: string
  events?: AgentEvent[]
  snapshot?: AgentSnapshot
  projection?: ConversationEntry[]
}>(), {
  preview: false,
  rgb: undefined,
})
const emit = defineEmits<{ select: [id: string] }>()

const appearance = useAppearanceStore()
const audio = useOutlineAudioStore()
const rows = useTemplateRef<HTMLLIElement[]>("rows")
const hovered = ref<string>()
const selectedPreview = ref(PREVIEW_ITEMS[7]!.id)
const audioEnabled = computed(() => props.preview || appearance.settings.outlineAudio)
const audioActive = computed(() => audioEnabled.value && audio.active)
const maxWidth = computed(() => props.maxWidth ?? appearance.settings.outlineAudioMaxWidth)
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
const items = computed<OutlineItem[]>(previous => {
  if (!props.events || !props.snapshot) return PREVIEW_ITEMS
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

const currentActive = computed(() => props.active || (!props.events ? selectedPreview.value : undefined))
const hoveredIndex = computed(() => items.value.findIndex(item => item.id === hovered.value))
const highlighted = computed(() => hovered.value ?? currentActive.value)

function tickWidth(index: number, label: string): number {
  const baseline = OUTLINE_MIN_WIDTH + (22 * label.length) / (label.length + 10)
  if (hoveredIndex.value < 0) {
    return audioEnabled.value ? audio.width(index, items.value.length, baseline, maxWidth.value) : baseline
  }
  const distance = Math.abs(index - hoveredIndex.value)
  return distance <= 3 ? 32 - distance * 5 : baseline
}

function onSelect(id: string): void {
  if (!props.events) selectedPreview.value = id
  emit("select", id)
}

const list = useTemplateRef<HTMLElement>("list")
const { fadeStyle } = useScrollFade(list, { size: "sm" })

watch(currentActive, id => {
  const index = items.value.findIndex(item => item.id === id)
  rows.value?.[index]?.scrollIntoView({ block: "nearest" })
}, { flush: "post" })
</script>

<template>
  <nav
    v-if="items.length"
    :style="{ width: `${Math.max(32, audioEnabled ? maxWidth : 32)}px` }"
    class="pointer-events-none flex max-h-full max-w-[calc(100%-0.5rem)] flex-col"
  >
    <TooltipProvider :delay-duration="250">
      <div class="ui-scroll-mask flex min-h-0 flex-col" :style="fadeStyle">
        <ol ref="list" class="min-h-0 overflow-x-hidden overflow-y-auto scrollbar-none">
        <li v-for="(item, index) in items" :key="item.id" ref="rows">
          <TooltipRoot>
            <TooltipTrigger
              type="button"
              :aria-label="item.label"
              :aria-current="currentActive === item.id ? 'location' : undefined"
              class="group pointer-events-auto flex h-2 w-8 cursor-pointer items-center rounded-sm"
              @pointerenter="hovered = item.id"
              @pointerleave="hovered = undefined"
              @click="onSelect(item.id)"
            >
              <span
                aria-hidden="true"
                :style="{ width: `${tickWidth(index, item.label)}px`, backgroundColor: rgb ? audio.color(index, highlighted === item.id) : undefined }"
                class="pointer-events-none h-0.5 shrink-0 rounded-full duration-150 ease-out"
                :class="[
                  audioActive && hoveredIndex < 0 ? 'transition-colors' : 'transition-[width,background-color]',
                  highlighted === item.id ? 'bg-ui-accent' : 'bg-ui-text-muted/45 group-focus-visible:bg-ui-text-muted',
                ]"
              />
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent
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
  </nav>
</template>
