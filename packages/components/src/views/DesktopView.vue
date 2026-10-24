<script setup lang="ts">
import { client as platformClient } from "@deskfleet/client/platform"

import { MonitorPlay } from "@lucide/vue"
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { DesktopCapabilities, VideoCodec } from "../../../client/src/desktop-media.ts"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import ResourcePath from "../components/chrome/ResourcePath.vue"
import { commonDesktopCodecs, useDesktopConnection } from "../composables/useDesktopConnection.ts"
import { useFleetStore } from "../stores/fleet.ts"

const props = defineProps<{ machineId: string }>()
const { t } = useI18n()
const fleet = useFleetStore()
const connection = useDesktopConnection(platformClient.desktop)
const { state, failure, stream } = connection
const machine = computed(() => fleet.findMachine(props.machineId))
const local = computed(() => props.machineId === fleet.targetId)
const capabilities = shallowRef<DesktopCapabilities | null>(null)
const loading = ref(false)
const discoveryError = ref<string | null>(null)
const displayId = ref<number | null>(null)
const codec = ref<VideoCodec | null>(null)
const audio = ref(false)
const video = shallowRef<HTMLVideoElement | null>(null)
const playbackBlocked = ref(false)
const fullscreenError = ref(false)
let discoveryGeneration = 0

const codecs = computed(() => commonDesktopCodecs(
  capabilities.value?.codecs ?? [],
  typeof RTCRtpReceiver === "undefined" ? [] : RTCRtpReceiver.getCapabilities("video")?.codecs ?? [],
))
const active = computed(() => ["connecting", "starting", "connected"].includes(state.value))
const canConnect = computed(() => local.value && !loading.value && !active.value
  && fleet.localDesktopTarget.online && displayId.value !== null && codec.value !== null)

async function refresh(): Promise<void> {
  const generation = ++discoveryGeneration
  loading.value = true
  discoveryError.value = null
  capabilities.value = null
  displayId.value = null
  codec.value = null
  try {
    const target = await fleet.refreshLocalDesktop()
    if (generation !== discoveryGeneration || !local.value) return
    if (!target.online || !target.desktop) return
    const available = await platformClient.desktop.capabilities()
    if (generation !== discoveryGeneration || !local.value) return
    capabilities.value = available
    displayId.value = available.displays[0]?.id ?? null
    codec.value = codecs.value[0] ?? null
    if (!available.audio) audio.value = false
  } catch (error) {
    if (generation === discoveryGeneration) {
      discoveryError.value = error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (generation === discoveryGeneration) loading.value = false
  }
}

watch(() => props.machineId, () => {
  ++discoveryGeneration
  void connection.disconnect()
  capabilities.value = null
  loading.value = false
  discoveryError.value = null
  if (local.value) void refresh()
}, { immediate: true })
onBeforeUnmount(() => { ++discoveryGeneration })

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
  fullscreenError.value = false
  if (element) {
    element.srcObject = media
    if (media) void play()
  }
}, { flush: "post" })

function connect(): void {
  if (!canConnect.value || displayId.value === null || codec.value === null) return
  void connection.connect({ displayId: displayId.value, codec: codec.value, audio: audio.value })
}

async function fullscreen(): Promise<void> {
  try { await video.value?.requestFullscreen() }
  catch { fullscreenError.value = true }
}

const status = computed(() => {
  if (!machine.value) return t("desktop.notFound")
  if (!local.value) {
    if (!machine.value.online) return t("desktop.offline", { machine: machine.value.name })
    if (!machine.value.desktop) return t("desktop.noDisplay", { machine: machine.value.name })
    return t("desktop.unavailable")
  }
  if (state.value === "connecting") return t("desktop.connecting")
  if (state.value === "starting") return t("desktop.starting")
  if (state.value === "connected") return t("desktop.connected")
  if (failure.value?.kind === "timeout") return t("desktop.timeout")
  if (failure.value) return t("desktop.connectionFailed")
  if (loading.value) return t("desktop.checking")
  if (!fleet.localDesktopTarget.online) return t("desktop.daemonUnavailable")
  if (discoveryError.value) return t("desktop.discoveryFailed")
  if (!fleet.localDesktopTarget.desktop) return t("desktop.captureUnavailable")
  if (capabilities.value?.displays.length === 0) return t("desktop.noDisplay", { machine: machine.value.name })
  if (codecs.value.length === 0) return t("desktop.noCodec")
  return t("desktop.ready")
})
const detail = computed(() => local.value ? failure.value?.detail ?? discoveryError.value
  ?? (!fleet.localDesktopTarget.online ? fleet.localDesktopTarget.error : undefined) : undefined)
</script>

<template>
  <PaneHeader>
    <template v-if="machine">
      {{ t("machine.remoteDesktop") }}
      <ResourcePath :segments="[machine.name]" />
    </template>
  </PaneHeader>

  <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
    <div v-if="local" class="flex flex-wrap items-end gap-3">
      <label v-if="capabilities?.displays.length" class="flex flex-col gap-1 text-xs text-ui-text-muted">
        {{ t("desktop.display") }}
        <select v-model="displayId" class="desktop-select" :disabled="active">
          <option v-for="display in capabilities.displays" :key="display.id" :value="display.id">
            {{ t("desktop.displayOption", { id: display.id, width: display.width, height: display.height }) }}
          </option>
        </select>
      </label>
      <label v-if="codecs.length" class="flex flex-col gap-1 text-xs text-ui-text-muted">
        {{ t("desktop.codec") }}
        <select v-model="codec" class="desktop-select" :disabled="active">
          <option v-for="supported in codecs" :key="supported" :value="supported">{{ supported.toUpperCase() }}</option>
        </select>
      </label>
      <label v-if="capabilities?.audio" class="flex h-8 items-center gap-2 text-ui-text-muted">
        <input v-model="audio" type="checkbox" :disabled="active" />
        {{ t("desktop.audio") }}
      </label>
      <button v-if="active" type="button" class="ui-text-button border border-ui-border" @click="connection.disconnect()">
        {{ t("desktop.disconnect") }}
      </button>
      <button v-else type="button" class="ui-text-button border border-ui-border disabled:op-40" :disabled="!canConnect" @click="connect">
        {{ t("desktop.connect") }}
      </button>
      <button type="button" class="ui-text-button disabled:op-40" :disabled="loading || active" @click="refresh">
        {{ t("desktop.retry") }}
      </button>
      <button v-if="state === 'connected'" type="button" class="ui-text-button" @click="fullscreen">
        {{ t("desktop.fullscreen") }}
      </button>
    </div>

    <div class="flex min-h-64 min-w-0 flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-ui-border bg-ui-surface p-3 text-ui-text-muted">
      <video
        v-if="local"
        v-show="stream"
        ref="video"
        class="max-h-full min-h-0 w-full flex-1 object-contain"
        :aria-label="t('desktop.video')"
        :muted="!audio"
        autoplay
        playsinline
      />
      <MonitorPlay v-if="!stream" :size="32" :stroke-width="1.5" aria-hidden="true" />
      <p class="m-0 text-center" role="status">{{ status }}</p>
      <p v-if="detail" class="m-0 max-w-xl break-words text-center text-xs" role="alert">{{ detail }}</p>
      <button v-if="playbackBlocked" type="button" class="ui-text-button border border-ui-border" @click="play">
        {{ t("desktop.play") }}
      </button>
      <p v-if="fullscreenError" class="m-0 text-xs" role="alert">{{ t("desktop.fullscreenFailed") }}</p>
    </div>
  </div>
</template>

<style scoped>
.desktop-select {
  min-height: 2rem;
  padding: 0.25rem 0.5rem;
  color: var(--ui-color-text);
  background: var(--ui-color-surface);
  border: 1px solid var(--ui-color-border);
  border-radius: 0.375rem;
}
</style>
