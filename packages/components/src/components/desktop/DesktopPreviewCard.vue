<script setup lang="ts">
import { ArrowUpRight, LoaderCircle, MonitorPlay, Play, RefreshCw } from "@lucide/vue"
import { watchImmediate } from "@vueuse/core"
import { computed, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { DesktopDisplay, DesktopMediaApi } from "@deskfleet/client/desktop-media"
import { commonPreviewCodecs, useDesktopConnection } from "../../composables/useDesktopConnection.ts"
import UiButton from "../common/UiButton.vue"
import { displayLabel } from "./display-label.ts"

const props = defineProps<{ api: DesktopMediaApi; display: DesktopDisplay; displayIndex: number; machineName: string; active: boolean; showMachineName?: boolean }>()
defineEmits<{ open: [] }>()
const { t } = useI18n()
const displayTitle = computed(() => displayLabel(props.display, props.displayIndex, t))
const connection = useDesktopConnection(props.api)
const { state, stream, failure } = connection
const video = useTemplateRef<HTMLVideoElement>("video")
const playbackBlocked = ref(false)
const codecs = computed(() => commonPreviewCodecs(props.display.codecs, typeof RTCRtpReceiver === "undefined" ? [] : RTCRtpReceiver.getCapabilities("video")?.codecs ?? []))
const connecting = computed(() => state.value === "connecting" || state.value === "starting")
const status = computed(() => {
  if (props.active && state.value === "connected") return ""
  return t(!props.active ? "desktopOverview.paused" : !codecs.value.length ? "desktop.noCodec" : failure.value ? "desktop.connectionFailed" : "desktopOverview.connecting")
})

function connect(): void {
  if (!props.active || !codecs.value.length) return
  void connection.connect({ displayId: props.display.id, codecs: codecs.value, audio: false, control: false, fps: 1, bitrateBps: 150_000, maxWidth: 320, maxHeight: 180 })
}
watchImmediate(() => props.active, active => { if (active) connect(); else void connection.disconnect() })

async function play(): Promise<void> {
  const element = video.value
  const media = element?.srcObject
  if (!element || !media) return
  try {
    await element.play()
    if (video.value === element && element.srcObject === media) playbackBlocked.value = false
  } catch {
    if (video.value === element && element.srcObject === media) playbackBlocked.value = true
  }
}
watch([video, stream], ([element, media]) => {
  playbackBlocked.value = false
  if (element) { element.srcObject = media; if (media) void play() }
}, { flush: "post" })
</script>

<template>
  <article class="max-w-full overflow-hidden rounded-xl border border-ui-border bg-ui-surface" :class="showMachineName ? 'w-full' : 'w-80'" :data-preview-display="display.id">
    <button type="button" class="group relative block aspect-video w-full cursor-pointer overflow-hidden bg-ui-desktop text-white focus-visible:outline-2 focus-visible:outline-ui-accent" :aria-label="t('desktopOverview.openDisplay', { machine: machineName, display: displayTitle })" @click="$emit('open')">
      <video ref="video" v-show="stream && state === 'connected'" class="absolute inset-0 h-full w-full object-contain" :aria-label="t('desktop.video')" width="320" height="180" muted autoplay playsinline />
      <span v-if="!stream || state !== 'connected'" class="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center text-xs text-white/60">
        <LoaderCircle v-if="connecting" :size="22" class="animate-spin" aria-hidden="true" />
        <MonitorPlay v-else :size="24" :stroke-width="1.5" aria-hidden="true" />
        <span role="status">{{ status }}</span>
      </span>
      <span class="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-lg bg-black/60 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"><ArrowUpRight :size="16" aria-hidden="true" /></span>
    </button>
    <footer class="flex items-center justify-between gap-2 px-3 py-2.5">
      <span class="min-w-0 text-[13px] font-medium">
        <span v-if="showMachineName" class="block truncate">{{ machineName }}</span>
        <span class="block truncate" :class="showMachineName && 'text-xs font-normal text-ui-text-muted'" :title="displayTitle">{{ displayTitle }}</span>
      </span>
      <span v-if="status" class="flex shrink-0 items-center gap-1.5 text-xs text-ui-text-muted"><span class="ui-status-dot text-ui-text-faint" aria-hidden="true" />{{ status }}</span>
    </footer>
    <div v-if="failure || playbackBlocked" class="flex flex-col items-start gap-2 border-t border-ui-border px-3 py-3">
      <p v-if="failure" role="alert" class="m-0 break-words text-xs text-ui-text-muted">{{ failure.detail || t('desktop.connectionFailed') }}</p>
      <UiButton v-if="failure" type="button" size="sm" :disabled="!active" @click="connect"><RefreshCw :size="12" aria-hidden="true" />{{ t('desktop.retry') }}</UiButton>
      <UiButton v-if="playbackBlocked" type="button" size="sm" @click="play"><Play :size="12" aria-hidden="true" />{{ t('desktop.play') }}</UiButton>
    </div>
  </article>
</template>
