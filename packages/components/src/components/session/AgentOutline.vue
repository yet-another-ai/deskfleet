<script lang="ts">
import { fittedOklch } from "@proj-airi/chromatic"
import { createSharedComposable, useEventListener, useRafFn, watchImmediate } from "@vueuse/core"
import { computed, onScopeDispose, ref, shallowRef, triggerRef, useTemplateRef, watch } from "vue"
import type { AgentEvent, AgentInput, AgentSnapshot } from "../../../../../apps/daemon/src/agent-protocol.ts"
import { projectConversation } from "../../services/agent-conversation.ts"
import { useAppearanceStore } from "../../stores/appearance.ts"

interface OutlineItem {
  id: string
  label: string
  reply?: string
}

const BAND_COUNT = 24
const MIN_WIDTH = 6
const MIN_HZ = 50
const MIN_DB = -80
const MAX_DB = -10
const TILT_DB_PER_OCT = 2.0
const SIGNAL_THRESHOLD = 0.02
const STEVENS_EXPONENT = 0.65

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

function binAmplitude(bins: Float32Array<ArrayBuffer>, index: number): number {
  const db = bins[index] ?? -Infinity
  return db > MIN_DB ? 10 ** (Math.min(0, db - MAX_DB) / 20) : 0
}

function interpolateBin(bins: Float32Array<ArrayBuffer>, position: number): number {
  const lo = Math.floor(position)
  const hi = Math.min(bins.length - 1, lo + 1)
  const fraction = position - lo
  return binAmplitude(bins, lo) * (1 - fraction) + binAmplitude(bins, hi) * fraction
}

function demoBandTarget(band: number, now: number): number {
  const u = band / (BAND_COUNT - 1)
  const t = now * 0.001
  const beat = t * 1.9
  const kickPhase = beat % 1
  const kickEnv = kickPhase < 0.18 ? Math.sin((kickPhase / 0.18) * Math.PI) : 0
  const kick = kickEnv * Math.exp(-u * u * 5.2)

  const eighthPhase = (beat * 2) % 1
  const eighthEnv = eighthPhase < 0.3 ? Math.sin((eighthPhase / 0.3) * Math.PI) : 0
  const ripple = Math.max(0, Math.sin(u * 5.4 - t * 6.2) * 0.62 + Math.sin(u * 9.2 - t * 3.6) * 0.38)
  const mids = ripple * (0.22 + 0.78 * eighthEnv) * Math.sin(u * Math.PI) * 0.92

  const hatPhase = ((beat + 0.5) * 2) % 1
  const hatEnv = hatPhase < 0.22 ? Math.sin((hatPhase / 0.22) * Math.PI) : 0
  const shimmer = (0.5 + 0.5 * Math.sin(u * 11 + t * 8.5)) * hatEnv * (u ** 1.25) * 0.68

  const swell = 0.84 + 0.16 * Math.sin(t * 1.3)
  return Math.min(1, (kick + mids + shimmer) * swell)
}

const useOutlineAudio = createSharedComposable(() => {
  const appearance = useAppearanceStore()
  const decayOverride = ref<number>()
  const decayMs = computed(() => decayOverride.value ?? appearance.settings.outlineAudioDecayMs)
  const previewCount = ref(0)
  const bands = shallowRef(new Float32Array(BAND_COUNT))
  const activity = ref(0)
  const hue = ref(220)
  const raw = new Float32Array(BAND_COUNT)
  const targets = new Float32Array(BAND_COUNT)
  let runningPeak = 0.3
  let prevTime = 0
  let context: AudioContext | undefined
  let analyser: AnalyserNode | undefined
  let bins: Float32Array<ArrayBuffer> | undefined

  function step(): void {
    const now = performance.now()
    const dt = prevTime > 0 ? Math.min(64, now - prevTime) : 16.67
    prevTime = now
    hue.value = (now * 0.07) % 360
    let frameMax = 0
    let frameSum = 0

    if (analyser && bins && context) {
      analyser.getFloatFrequencyData(bins)
      const maxBin = bins.length - 1
      const binScale = (bins.length * 2) / context.sampleRate
      const ratio = Math.min(6_400, context.sampleRate * 0.45) / MIN_HZ

      for (let band = 0; band < BAND_COUNT; band++) {
        const f0 = MIN_HZ * ratio ** (band / BAND_COUNT)
        const fc = MIN_HZ * ratio ** ((band + 0.5) / BAND_COUNT)
        const f1 = MIN_HZ * ratio ** ((band + 1) / BAND_COUNT)
        const startBin = Math.max(1, Math.ceil(f0 * binScale))
        const endBin = Math.min(maxBin, Math.floor(f1 * binScale))
        let peak = interpolateBin(bins, Math.min(maxBin, Math.max(1, fc * binScale)))
        let sumSq = peak * peak
        let count = 1

        for (let bin = startBin; bin <= endBin; bin++) {
          const amp = binAmplitude(bins, bin)
          if (amp > peak) peak = amp
          sumSq += amp * amp
          count++
        }

        const amplitude = peak * 0.35 + Math.sqrt(sumSq / count) * 0.65
        const tilt = (fc / MIN_HZ) ** (TILT_DB_PER_OCT / 6.0206)
        const perceived = Math.min(1, (amplitude * tilt) ** STEVENS_EXPONENT)
        const value = perceived < SIGNAL_THRESHOLD ? 0 : perceived
        raw[band] = value
        if (value > frameMax) frameMax = value
        frameSum += value
      }
    }

    if (frameMax === 0 && previewCount.value > 0) {
      for (let i = 0; i < BAND_COUNT; i++) {
        targets[i] = demoBandTarget(i, now)
      }
    } else {
      runningPeak = frameMax > runningPeak
        ? runningPeak + (frameMax - runningPeak) * 0.12
        : Math.max(0.25, runningPeak * 0.997)
      const frameMean = frameSum / BAND_COUNT / runningPeak

      for (let i = 0; i < BAND_COUNT; i++) {
        const norm = Math.min(1, (raw[i] ?? 0) / runningPeak)
        const prominence = Math.max(0, norm - frameMean * 0.45) / Math.max(0.55, 1 - frameMean * 0.35)
        targets[i] = Math.min(1, norm * 0.45 + prominence * 0.55)
      }
    }

    const release = decayMs.value > 0 ? 1 - Math.exp(-dt / decayMs.value) : 1
    const attack = 0.35
    for (let i = 0; i < BAND_COUNT; i++) {
      const prev = targets[Math.max(0, i - 1)] ?? 0
      const curr = targets[i] ?? 0
      const next = targets[Math.min(BAND_COUNT - 1, i + 1)] ?? 0
      const target = prev * 0.22 + curr * 0.56 + next * 0.22
      const current = bands.value[i] ?? 0
      const updated = current + (target - current) * (target > current ? attack : release)
      bands.value[i] = updated < 0.002 ? 0 : updated
    }

    activity.value = frameMax > 0 || previewCount.value > 0
      ? Math.min(1, activity.value + (1 - activity.value) * 0.18)
      : Math.max(0, activity.value * (1 - release) - 0.002)
    if (activity.value > 0) triggerRef(bands)
  }

  const { pause, resume } = useRafFn(step, { immediate: false })
  const active = computed(() => activity.value > 0)

  function startPreview(): () => void {
    previewCount.value++
    prevTime = 0
    resume()
    return () => {
      previewCount.value = Math.max(0, previewCount.value - 1)
      if (previewCount.value === 0 && !appearance.settings.outlineAudio) {
        pause()
        bands.value.fill(0)
        activity.value = 0
      }
    }
  }

  function width(index: number, count: number, baseline: number, targetMaxWidth: number): number {
    const mix = activity.value
    if (mix <= 0) return baseline
    const maxStep = Math.floor((count - 1) / 2)
    const pos = (maxStep > 0 ? Math.floor(Math.abs(index - (count - 1) / 2)) / maxStep : 0) * (BAND_COUNT - 1)
    const lo = Math.floor(pos)
    const hi = Math.min(BAND_COUNT - 1, lo + 1)
    const energy = (bands.value[lo] ?? 0) * (1 - (pos - lo)) + (bands.value[hi] ?? 0) * (pos - lo)
    const audioWidth = MIN_WIDTH + energy * (Math.max(MIN_WIDTH, targetMaxWidth) - MIN_WIDTH)
    return baseline * (1 - mix) + audioWidth * mix
  }

  function color(index: number, highlighted: boolean): string {
    const deg = (((hue.value - index * 18) % 360) + 360) % 360
    const { l, c, h } = fittedOklch(500, deg)
    return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)}deg / ${highlighted ? 1 : 0.72})`
  }

  watchImmediate(() => appearance.settings.outlineAudio, (enabled, _, onCleanup) => {
    if (!enabled) return
    prevTime = 0
    resume()
    let stopped = false
    let stream: MediaStream | undefined

    onCleanup(() => {
      stopped = true
      if (previewCount.value === 0) pause()
      analyser = undefined
      bins = undefined
      raw.fill(0)
      targets.fill(0)
      bands.value.fill(0)
      runningPeak = 0.3
      for (const track of stream?.getTracks() ?? []) track.stop()
      context?.close().catch(() => {})
      context = undefined
      if (previewCount.value === 0) activity.value = 0
    })

    if (typeof AudioContext === "undefined" || !navigator.mediaDevices?.getDisplayMedia) return
    function startCapture(): void {
      navigator.mediaDevices.getDisplayMedia({
        video: { width: 1, height: 1, frameRate: 1 },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      }).then(media => {
        for (const track of media.getVideoTracks()) track.stop()
        if (stopped) {
          for (const track of media.getTracks()) track.stop()
          return
        }
        stream = media
        context = new AudioContext()
        analyser = context.createAnalyser()
        analyser.fftSize = 4096
        analyser.smoothingTimeConstant = 0.5
        context.createMediaStreamSource(media).connect(analyser)
        bins = new Float32Array(analyser.frequencyBinCount)
        step()
      }).catch(error => {
        console.warn("Could not start outline audio loopback:", error)
      })
    }
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      const stop = useEventListener(["pointerdown", "keydown"], () => {
        stop()
        startCapture()
      }, { capture: true, once: true })
      onCleanup(stop)
      return
    }
    startCapture()
  })

  onScopeDispose(pause)

  return { decayOverride, active, width, color, startPreview }
})
</script>

<script setup lang="ts">
import { TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from "reka-ui"

const props = withDefaults(defineProps<{
  /** Preview overrides; omitted values use the saved appearance. */
  preview?: boolean
  rgb?: boolean
  maxWidth?: number
  decayMs?: number
  active?: string
  events?: AgentEvent[]
  snapshot?: AgentSnapshot
}>(), {
  preview: false,
  rgb: undefined,
})
const emit = defineEmits<{ select: [id: string] }>()

const appearance = useAppearanceStore()
const rows = useTemplateRef<HTMLLIElement[]>("rows")
const hovered = ref<string>()
const selectedPreview = ref(PREVIEW_ITEMS[7]!.id)
const audio = useOutlineAudio()
const audioEnabled = computed(() => props.preview || appearance.settings.outlineAudio)
const audioActive = computed(() => audioEnabled.value && audio.active.value)
const maxWidth = computed(() => props.maxWidth ?? appearance.settings.outlineAudioMaxWidth)
const rgb = computed(() => props.rgb ?? (audioEnabled.value && appearance.settings.outlineAudioRgb))

watchImmediate(() => props.decayMs, value => { audio.decayOverride.value = value })

watchImmediate(() => props.preview, (isPreview, _, onCleanup) => {
  if (isPreview) onCleanup(audio.startPreview())
})

function plainText(content: AgentInput["content"]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === "text") parts.push(block.text)
    else if (block.type === "resource" && "text" in block.resource) parts.push(block.resource.text)
  }
  return parts.join(" ").replace(/\s+/gu, " ").trim()
}

const items = computed<OutlineItem[]>(() => {
  if (!props.events || !props.snapshot) return PREVIEW_ITEMS
  const result: OutlineItem[] = []
  for (const entry of projectConversation(props.events, props.snapshot)) {
    if (entry.kind === "input") {
      result.push({ id: entry.id, label: plainText(entry.input.content) })
      continue
    }
    if (entry.kind === "message" && entry.role === "assistant" && result.length) {
      const reply = plainText(entry.content)
      if (reply) result.at(-1)!.reply = reply
    }
  }
  return result
})

const currentActive = computed(() => props.active || (!props.events ? selectedPreview.value : undefined))
const hoveredIndex = computed(() => items.value.findIndex(item => item.id === hovered.value))
const highlighted = computed(() => hovered.value ?? currentActive.value)

function tickWidth(index: number, label: string): number {
  const baseline = MIN_WIDTH + (22 * label.length) / (label.length + 10)
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
      <ol class="min-h-0 overflow-x-hidden overflow-y-auto scrollbar-none">
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
    </TooltipProvider>
  </nav>
</template>
