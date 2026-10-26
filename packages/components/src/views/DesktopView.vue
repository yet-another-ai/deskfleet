<script setup lang="ts">
import UiButton from "../components/common/UiButton.vue"
import UiSelect from "../components/common/UiSelect.vue"
import UiCheckbox from "../components/common/UiCheckbox.vue"
import { client as platformClient } from "@deskfleet/client/platform"

import { GripVertical, LoaderCircle, Maximize, Minimize, MonitorPlay, Play, RefreshCw, SlidersHorizontal, Unplug } from "@lucide/vue"
import { watchImmediate, whenever } from "@vueuse/core"
import { computed, onBeforeUnmount, ref, shallowRef, useTemplateRef, watch } from "vue"
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui"
import { useI18n } from "vue-i18n"
import type { DesktopCapabilities } from "../../../client/src/desktop-media.ts"
import IconButton from "../components/common/IconButton.vue"
import { commonDesktopCodecs, desktopCodecLabel, useDesktopConnection } from "../composables/useDesktopConnection.ts"
import { useDesktopInput } from "../composables/useDesktopInput.ts"
import { useFloatingToolbar } from "../composables/useFloatingToolbar.ts"
import { useFleetStore } from "../stores/fleet.ts"

const props = withDefaults(defineProps<{ machineId: string; visible?: boolean }>(), { visible: true })
const { t } = useI18n()
const fleet = useFleetStore()
const connection = useDesktopConnection(platformClient.desktop)
const { state, failure, stream, codec: activeCodec } = connection
const machine = computed(() => fleet.findMachine(props.machineId))
const local = computed(() => props.machineId === fleet.targetId)
const capabilities = shallowRef<DesktopCapabilities | null>(null)
const loading = ref(false)
const discoveryError = ref<string | null>(null)
const displayId = ref<number | null>(null)
const audio = ref(false)
const control = ref(false)
const controlPaused = ref(false)
const video = shallowRef<HTMLVideoElement | null>(null)
const inputEnabled = computed(() => control.value && !controlPaused.value && connection.inputReady.value)
useDesktopInput(video, inputEnabled, connection.sendInput)
const playbackBlocked = ref(false)
const fullscreenError = ref(false)
const isFullscreen = ref(false)
const settingsOpen = ref(false)

const stage = useTemplateRef<HTMLElement>("stage")
const toolbar = useTemplateRef<HTMLElement>("toolbar")
let discoveryGeneration = 0

// The toolbar can cover any part of the remote screen, so the viewer can move it.
const { position: toolbarPosition, startDrag, moveDrag, endDrag, nudge: nudgeToolbar, panelSide: settingsSide } = useFloatingToolbar(stage, toolbar)

const codecs = computed(() => commonDesktopCodecs(
  capabilities.value?.displays.find(display => display.id === displayId.value)?.codecs ?? [],
  typeof RTCRtpReceiver === "undefined" ? [] : RTCRtpReceiver.getCapabilities("video")?.codecs ?? [],
))
const chosenCodec = computed(() => activeCodec.value ?? codecs.value[0] ?? null)
const codecLabel = computed(() => chosenCodec.value ? desktopCodecLabel(chosenCodec.value) : "")
const active = computed(() => ["connecting", "starting", "connected"].includes(state.value))
const canConnect = computed(() => props.visible && local.value && !loading.value && !active.value
  && fleet.localDesktopTarget.online && displayId.value !== null && chosenCodec.value !== null)

async function refresh(): Promise<void> {
  const generation = ++discoveryGeneration
  loading.value = true
  discoveryError.value = null
  capabilities.value = null
  displayId.value = null
  try {
    const target = await fleet.refreshLocalDesktop()
    if (generation !== discoveryGeneration || !local.value) return
    if (!target.online || !target.desktop) return
    const available = await platformClient.desktop.capabilities()
    if (generation !== discoveryGeneration || !local.value) return
    capabilities.value = available
    displayId.value = available.displays[0]?.id ?? null
    if (!available.audio) audio.value = false
  } catch (error) {
    if (generation === discoveryGeneration) {
      discoveryError.value = error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (generation === discoveryGeneration) loading.value = false
  }
}

watchImmediate(() => props.machineId, () => {
  ++discoveryGeneration
  void connection.disconnect()
  capabilities.value = null
  loading.value = false
  discoveryError.value = null
  if (local.value) void refresh()
})
whenever(() => !props.visible, () => { void connection.disconnect() })
// Encoder fallback clears the stream while the next peer connects. Stay in fullscreen through that gap.
watch([() => props.visible, stream, isFullscreen, state], ([visible, media, , connectionState]) => {
  const recovering = !media && (connectionState === "connecting" || connectionState === "starting")
  if (!visible || (!media && !recovering)) void exitFullscreen()
})
onBeforeUnmount(() => {
  ++discoveryGeneration
  void exitFullscreen()
})

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
  if (!canConnect.value || displayId.value === null || codecs.value.length === 0) return
  controlPaused.value = false
  void connection.connect({ displayId: displayId.value, codecs: codecs.value, audio: audio.value, control: control.value })
}

function toggleControl(): void {
  controlPaused.value = !controlPaused.value
  if (!controlPaused.value) video.value?.focus({ preventScroll: true })
}

async function fullscreen(): Promise<void> {
  fullscreenError.value = false
  const element = stage.value
  if (!element) return
  if (document.fullscreenElement === element) return exitFullscreen()
  try {
    await element.requestFullscreen()
  }
  catch { fullscreenError.value = true }
}

async function exitFullscreen(): Promise<void> {
  if (!stage.value || document.fullscreenElement !== stage.value) return
  fullscreenError.value = false
  try { await document.exitFullscreen() }
  catch { fullscreenError.value = true }
}

function updateFullscreen(): void {
  isFullscreen.value = document.fullscreenElement === stage.value
}

const status = computed(() => {
  if (!machine.value) return t("desktop.notFound")
  if (!local.value) {
    if (!machine.value.online) return t("desktop.offline", { machine: machine.value.name })
    if (!machine.value.desktop) return t("desktop.noDisplay", { machine: machine.value.name })
    return t("desktop.unavailable")
  }
  if (state.value === "connecting") return t("desktop.connecting", { codec: codecLabel.value })
  if (state.value === "starting") return t("desktop.starting", { codec: codecLabel.value })
  if (state.value === "connected") return t("desktop.connected", { codec: codecLabel.value })
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
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The stream fills the pane; its controls and settings float above it. -->
    <div ref="stage" data-desktop-stage class="relative flex min-h-64 min-w-0 flex-1 flex-col items-center justify-center overflow-hidden rounded-xl border transition-colors" :class="stream ? 'border-transparent bg-ui-terminal' : 'border-ui-border bg-ui-surface'" @fullscreenchange="updateFullscreen">
      <video
        v-if="local"
        v-show="stream"
        ref="video"
        class="absolute inset-0 h-full w-full object-contain"
        :class="inputEnabled && 'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ui-accent'"
        :tabindex="inputEnabled ? 0 : -1"
        :title="inputEnabled ? t('desktop.controlHint') : undefined"
        :aria-label="t('desktop.video')"
        :muted="!audio"
        autoplay
        playsinline
      />

      <div v-if="!stream" class="flex max-w-md flex-col items-center gap-3 p-6 text-center">
        <span class="mb-1 flex h-14 w-14 items-center justify-center rounded-2xl bg-ui-accent/10 text-ui-accent" aria-hidden="true">
          <LoaderCircle v-if="local && (active || loading)" :size="26" :stroke-width="1.75" class="animate-spin" />
          <MonitorPlay v-else :size="28" :stroke-width="1.5" />
        </span>
        <p class="m-0 text-sm font-medium" role="status">{{ status }}</p>
        <p v-if="detail" class="m-0 break-words text-[13px] text-ui-text-muted" role="alert">{{ detail }}</p>
        <div v-if="local" class="mt-2 flex flex-wrap items-center justify-center gap-2">
          <UiButton v-if="active" type="button" @click="connection.disconnect()">{{ t("desktop.disconnect") }}</UiButton>
          <UiButton variant="primary" v-else type="button" :disabled="!canConnect" @click="connect">{{ t("desktop.connect") }}</UiButton>
          <UiButton variant="ghost" size="sm" type="button" class="cursor-pointer hover:bg-ui-hover hover:text-ui-text disabled:cursor-default disabled:op-40" :disabled="loading || active" @click="refresh">
            <RefreshCw :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t("desktop.retry") }}
          </UiButton>
        </div>
      </div>

      <UiButton variant="primary" v-if="playbackBlocked" type="button" class="absolute" @click="play">
        <Play :size="14" :stroke-width="2" aria-hidden="true" />{{ t("desktop.play") }}
      </UiButton>

      <PopoverRoot v-if="local" v-model:open="settingsOpen">
      <div
        ref="toolbar"
        class="absolute z-10 flex items-center gap-1 rounded-xl border border-ui-border bg-ui-surface p-1 shadow-ui-popover"
        :class="!toolbarPosition && 'top-3 right-3'"
        :style="toolbarPosition && { left: `${toolbarPosition.x}px`, top: `${toolbarPosition.y}px` }"
      >
        <button
          type="button"
          class="inline-flex h-7 w-5 shrink-0 cursor-grab items-center justify-center rounded-md text-ui-text-faint hover:bg-ui-hover hover:text-ui-text-muted active:cursor-grabbing"
          style="touch-action: none"
          data-move-controls
          :aria-label="t('desktop.moveControls')"
          :title="t('desktop.moveControls')"
          @pointerdown="startDrag"
          @pointermove="moveDrag"
          @pointerup="endDrag"
          @pointercancel="endDrag"
          @keydown="nudgeToolbar"
        ><GripVertical :size="14" :stroke-width="1.75" aria-hidden="true" /></button>
        <span v-if="stream" role="status" class="flex items-center gap-1.5 px-2 text-[13px] text-ui-text-muted">
          <span class="h-1.5 w-1.5 rounded-full" :class="state === 'connected' ? 'bg-ui-success' : 'bg-ui-text-faint'" aria-hidden="true" />{{ status }}
        </span>
        <IconButton :portal-to="stage ?? undefined" v-if="isFullscreen || (stream && state === 'connected')" :icon="isFullscreen ? Minimize : Maximize" :label="t(isFullscreen ? 'desktop.exitFullscreen' : 'desktop.fullscreen')" @click="fullscreen" />
        <UiButton v-if="stream && control && state === 'connected'" type="button" class="py-1" :disabled="!connection.inputReady.value" :aria-pressed="!controlPaused" @click="toggleControl">
          {{ controlPaused ? t("desktop.resumeControl") : t("desktop.pauseControl") }}
        </UiButton>
        <PopoverTrigger :as="IconButton" :portal-to="stage ?? undefined" :icon="SlidersHorizontal" :label="t('desktop.settings')" :disabled="!capabilities" />
        <UiButton variant="danger" v-if="stream && active" type="button" class="py-1" @click="connection.disconnect()">
          <Unplug :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t("desktop.disconnect") }}
        </UiButton>

        <!-- Stay inside the fullscreen stage, including nested select portals. -->
        <PopoverPortal :to="stage ?? undefined">
        <PopoverContent :side="settingsSide.above ? 'top' : 'bottom'" :align="settingsSide.alignStart ? 'start' : 'end'" :side-offset="8" :collision-boundary="stage" :collision-padding="12" :aria-label="t('desktop.settings')" class="ui-menu z-50 flex w-72 flex-col gap-3 p-3">
          <label v-if="capabilities?.displays.length" class="flex flex-col gap-1.5 text-[13px] text-ui-text-muted">
            {{ t("desktop.display") }}
            <UiSelect :model-value="String(displayId ?? '')" :options="capabilities.displays.map(display => ({ value: String(display.id), label: t('desktop.displayOption', { id: display.id, width: display.width, height: display.height }) }))" :portal-to="stage ?? undefined" :aria-label="t('desktop.display')" :disabled="active" @update:model-value="displayId = Number($event)" />
          </label>
          <p v-if="chosenCodec" class="m-0 text-[13px] text-ui-text-muted" data-desktop-codec>{{ t("desktop.codecStatus", { codec: codecLabel }) }}</p>
          <label v-if="capabilities?.audio" class="flex items-center gap-2 text-[13px]">
            <UiCheckbox v-model="audio" :disabled="active" />
            {{ t("desktop.audio") }}
          </label>
          <label class="flex items-center gap-2 text-[13px]">
            <UiCheckbox v-model="control" data-desktop-control :disabled="active" />
            {{ t("desktop.control") }}
          </label>
          <p v-if="active" class="m-0 text-xs text-ui-text-muted">{{ t("desktop.settingsLocked") }}</p>
        </PopoverContent>
        </PopoverPortal>
      </div>
      </PopoverRoot>

      <p v-if="fullscreenError" role="alert" class="ui-notice absolute bottom-3 left-3 m-0 border-ui-danger/30 bg-ui-surface text-ui-danger">{{ t("desktop.fullscreenFailed") }}</p>
    </div>
  </div>
</template>
