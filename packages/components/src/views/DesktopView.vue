<script setup lang="ts">
import UiButton from "../components/common/UiButton.vue"
import UiSelect from "../components/common/UiSelect.vue"
import UiCheckbox from "../components/common/UiCheckbox.vue"
import ErrorNotice from "../components/common/ErrorNotice.vue"
import { useConnectionResume } from "../composables/useConnectionResume.ts"
import { usePlatformClient } from "../composables/usePlatformClient.ts"

import { GripVertical, LoaderCircle, Maximize, Minimize, MonitorPlay, Play, RefreshCw, SlidersHorizontal, Unplug } from "@lucide/vue"
import { watchImmediate, whenever } from "@vueuse/core"
import { computed, onBeforeUnmount, ref, shallowRef, useTemplateRef, watch } from "vue"
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui"
import { useI18n } from "vue-i18n"
import type { DesktopCapabilities } from "../../../client/src/desktop-media.ts"
import { commonDesktopCodecs, desktopCodecLabel, useDesktopConnection } from "../composables/useDesktopConnection.ts"
import { useDesktopInput } from "../composables/useDesktopInput.ts"
import { useFloatingToolbar } from "../composables/useFloatingToolbar.ts"
import { useFleetStore } from "../stores/fleet.ts"
import { errorPresentation } from "../services/error-presentation.ts"
import { useFeatureGate } from "../services/analytics.ts"

const platformClient = usePlatformClient()
const nativePresenterEnabled = useFeatureGate("native_presentor")
const showNative = computed(() => !!platformClient.desktop.openNative && nativePresenterEnabled.value)

const props = withDefaults(defineProps<{ machineId: string; visible?: boolean; initialDisplayId?: number; autoConnect?: boolean }>(), { visible: true, autoConnect: false })
const { t } = useI18n()
const fleet = useFleetStore()
const connection = useDesktopConnection(platformClient.desktop)
const { state, failure, settingsFailure, stream, codec: activeCodec } = connection
const machine = computed(() => fleet.findMachine(props.machineId))
const local = computed(() => props.machineId === fleet.targetId)
const capabilities = shallowRef<DesktopCapabilities | null>(null)
const loading = ref(false)
const discoveryError = shallowRef<unknown>(null)
const nativeError = shallowRef<unknown>(null)
const nativeOpening = ref(false)
const displayId = ref<number | null>(null)
const audio = ref(true)
const control = ref(true)
const controlPaused = ref(false)
const video = shallowRef<HTMLVideoElement | null>(null)
const inputEnabled = computed(() => control.value && !controlPaused.value && connection.inputReady.value)
const windowsTarget = computed(() => fleet.localDesktopTarget.platform === "win32")
const secureAttentionAvailable = computed(() => windowsTarget.value && capabilities.value?.secureAttention === true)
useDesktopInput(video, inputEnabled, connection.sendInput)
const playbackBlocked = ref(false)
const fullscreenError = ref(false)
const isFullscreen = ref(false)
const settingsOpen = ref(false)

const stage = useTemplateRef<HTMLElement>("stage")
const toolbar = useTemplateRef<HTMLElement>("toolbar")
let discoveryGeneration = 0
let autoConnectPending = props.autoConnect

// The toolbar can cover any part of the remote screen, so the viewer can move it.
const { position: toolbarPosition, startDrag, moveDrag, endDrag, nudge: nudgeToolbar, panelSide: settingsSide } = useFloatingToolbar(stage, toolbar)

const codecs = computed(() => commonDesktopCodecs(
  capabilities.value?.displays.find(display => display.id === displayId.value)?.codecs ?? [],
  typeof RTCRtpReceiver === "undefined" ? [] : RTCRtpReceiver.getCapabilities("video")?.codecs ?? [],
))
const chosenCodec = computed(() => activeCodec.value ?? codecs.value[0] ?? null)
const codecLabel = computed(() => chosenCodec.value ? desktopCodecLabel(chosenCodec.value) : "")
const active = computed(() => ["connecting", "starting", "connected"].includes(state.value))
const canConnect = computed(() => props.visible && local.value && !loading.value && !active.value && !nativeOpening.value
  && fleet.localDesktopTarget.online && displayId.value !== null && chosenCodec.value !== null)
const canOpenNative = computed(() => showNative.value && props.visible && local.value
  && !loading.value && !active.value && !nativeOpening.value && fleet.localDesktopTarget.online
  && capabilities.value?.displays.some(display => display.id === displayId.value && display.codecs.some(codec => ["h264", "h265", "av1"].includes(codec))))

async function refresh(): Promise<void> {
  const generation = ++discoveryGeneration
  loading.value = true
  discoveryError.value = null
  nativeError.value = null
  capabilities.value = null
  displayId.value = null
  try {
    const target = await fleet.refreshLocalDesktop()
    if (generation !== discoveryGeneration || !local.value) return
    if (!target.online || !target.desktop) return
    const available = await platformClient.desktop.capabilities()
    if (generation !== discoveryGeneration || !local.value) return
    capabilities.value = available
    displayId.value = available.displays.find(display => display.id === props.initialDisplayId)?.id ?? available.displays[0]?.id ?? null
  } catch (error) {
    if (generation === discoveryGeneration) {
      discoveryError.value = error
    }
  } finally {
    if (generation === discoveryGeneration) {
      loading.value = false
      if (autoConnectPending && canConnect.value && (props.initialDisplayId === undefined || displayId.value === props.initialDisplayId)) {
        autoConnectPending = false
        connect()
      }
    }
  }
}

watchImmediate(() => props.machineId, () => {
  ++discoveryGeneration
  autoConnectPending = props.autoConnect
  void connection.disconnect()
  capabilities.value = null
  loading.value = false
  discoveryError.value = null
  if (local.value) void refresh()
})
whenever(() => !props.visible, () => { void connection.disconnect() })
// A suspended page can lose its media peer without switching tabs. Retry only
// transport failures; capture and permission errors keep their manual action.
useConnectionResume(() => {
  const reason = failure.value
  if (!props.visible || !canConnect.value || !reason) return
  if (!["connection", "timeout"].includes(reason.kind) || reason.relayDeniedReason) return
  connect()
})
// Automatic peer replacement clears the stream briefly. Stay in fullscreen through that gap.
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

watch([displayId, audio, control], ([, , controls], [, , previousControls]) => {
  if (controls !== previousControls) controlPaused.value = false
  applySettings()
})

function applySettings(): void {
  if (!active.value || !props.visible || !local.value || loading.value || displayId.value === null) return
  void connection.reconfigure({ displayId: displayId.value, codecs: codecs.value, audio: audio.value && capabilities.value?.audio === true, audioAvailable: capabilities.value?.audio === true, liveSettings: true, control: control.value })
}

function connect(): void {
  if (!canConnect.value || displayId.value === null || codecs.value.length === 0) return
  nativeError.value = null
  controlPaused.value = false
  void connection.connect({ displayId: displayId.value, codecs: codecs.value, audio: audio.value && capabilities.value?.audio === true, audioAvailable: capabilities.value?.audio === true, liveSettings: true, control: control.value })
}

function connectWithoutControl(): void {
  control.value = false
  connect()
}

async function openNative(): Promise<void> {
  if (!canOpenNative.value || displayId.value === null || !platformClient.desktop.openNative) return
  nativeOpening.value = true
  nativeError.value = null
  try { await platformClient.desktop.openNative({ displayId: displayId.value, control: control.value }) }
  catch (error) { nativeError.value = error }
  finally { nativeOpening.value = false }
}

function toggleControl(): void {
  controlPaused.value = !controlPaused.value
  if (!controlPaused.value) video.value?.focus({ preventScroll: true })
}

function sendSecureAttention(): void {
  if (!secureAttentionAvailable.value || state.value !== "connected" || !inputEnabled.value) return
  if (connection.sendInput({ type: "secureAttention" })) video.value?.focus({ preventScroll: true })
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
  if (nativeOpening.value) return t("desktop.nativeOpening")
  if (nativeError.value) return t("desktop.nativeFailed")
  if (failure.value?.kind === "timeout") return t("desktop.timeout")
  if (failure.value?.reason === "accessibility") return t("desktop.accessibilityFailed")
  if (failure.value) return t("desktop.connectionFailed")
  if (loading.value) return t("desktop.checking")
  if (!fleet.localDesktopTarget.online) return t("desktop.daemonUnavailable")
  if (discoveryError.value) return t("desktop.discoveryFailed")
  if (!fleet.localDesktopTarget.desktop) return t("desktop.captureUnavailable")
  if (capabilities.value?.displays.length === 0) return t("desktop.noDisplay", { machine: machine.value.name })
  if (codecs.value.length === 0 && !canOpenNative.value) return t("desktop.noCodec")
  return t("desktop.ready")
})
const detail = computed(() => local.value ? nativeError.value ?? failure.value?.error ?? failure.value?.detail ?? discoveryError.value
  ?? (!fleet.localDesktopTarget.online ? fleet.localDesktopTarget.error : undefined) : undefined)
const hasError = computed(() => local.value && !!(failure.value || detail.value))
const accessibilityFailure = computed(() => failure.value?.reason === "accessibility")
const errorDescription = computed(() => {
  if (accessibilityFailure.value) return t("desktop.accessibilityRecovery", { machine: machine.value?.name ?? fleet.localDesktopTarget.name })
  if (failure.value?.kind !== "connection" && failure.value?.kind !== "timeout") return undefined
  return errorPresentation(detail.value, failure.value?.relayDeniedReason).kind === "generic" ? t("errors.desktopUnlockHint") : undefined
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The stream fills the pane; its controls and settings float above it. -->
    <div ref="stage" data-desktop-stage class="relative flex min-h-64 min-w-0 flex-1 flex-col items-center justify-center overflow-hidden rounded-xl border ui-motion" :class="stream ? 'border-transparent bg-ui-desktop' : 'border-ui-border bg-ui-surface'" @fullscreenchange="updateFullscreen">
      <video
        v-if="local"
        v-show="stream"
        ref="video"
        class="absolute inset-0 h-full w-full object-contain"
        :class="inputEnabled && 'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ui-accent'"
        :tabindex="inputEnabled ? 0 : -1"
        :title="inputEnabled ? t('desktop.controlHint') : undefined"
        :aria-label="t('desktop.video')"
        :muted="!audio || !capabilities?.audio"
        autoplay
        playsinline
      />

      <div v-if="!stream" class="flex w-full max-w-md flex-col items-center gap-3 p-6 text-center">
        <span v-if="!hasError" class="mb-1 flex h-14 w-14 items-center justify-center rounded-2xl bg-ui-accent/10 text-ui-accent" aria-hidden="true">
          <LoaderCircle v-if="local && (active || loading || nativeOpening)" :size="26" :stroke-width="1.75" class="animate-spin" />
          <MonitorPlay v-else :size="28" :stroke-width="1.5" />
        </span>
        <ErrorNotice v-if="hasError" class="w-full text-left" :title="status" :error="detail" :relay-denied-reason="failure?.relayDeniedReason" :description="errorDescription" />
        <p v-else class="m-0 text-sm font-medium" role="status">{{ status }}</p>
        <div v-if="local" class="mt-2 flex flex-wrap items-center justify-center gap-2">
          <UiButton v-if="active" type="button" @click="connection.disconnect()">{{ t("desktop.disconnect") }}</UiButton>
          <UiButton variant="primary" v-else type="button" :disabled="!canConnect" @click="connect">{{ t(accessibilityFailure ? "desktop.retryControl" : "desktop.connect") }}</UiButton>
          <UiButton v-if="accessibilityFailure" type="button" :disabled="!canConnect" @click="connectWithoutControl">{{ t("desktop.connectWithoutControl") }}</UiButton>
          <UiButton v-if="showNative" type="button" data-native-desktop :disabled="!canOpenNative" :title="t('desktop.nativeHint')" @click="openNative">{{ t("desktop.openNative") }}</UiButton>
          <UiButton variant="ghost" size="sm" type="button" class="cursor-pointer hover:bg-ui-hover hover:text-ui-text disabled:cursor-default disabled:op-40" :disabled="loading || active || nativeOpening" @click="refresh">
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
        class="absolute z-10 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-1 rounded-xl border border-ui-border bg-ui-surface p-1 shadow-ui-popover"
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
          <span class="ui-status-dot" :class="state === 'connected' ? 'ui-status-live text-ui-success' : 'text-ui-text-faint'" aria-hidden="true" />{{ status }}
        </span>
        <UiButton variant="ghost" size="icon" :portal-to="stage ?? undefined" v-if="isFullscreen || (stream && state === 'connected')" :label="t(isFullscreen ? 'desktop.exitFullscreen' : 'desktop.fullscreen')" @click="fullscreen"><component :is="isFullscreen ? Minimize : Maximize" :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
        <UiButton v-if="stream && control && state === 'connected'" type="button" class="py-1" :disabled="!connection.inputReady.value" :aria-pressed="!controlPaused" @click="toggleControl">
          {{ controlPaused ? t("desktop.resumeControl") : t("desktop.pauseControl") }}
        </UiButton>
        <UiButton v-if="stream && control && state === 'connected' && secureAttentionAvailable" type="button" class="py-1" data-desktop-secure-attention :disabled="!inputEnabled" @click="sendSecureAttention">
          {{ t("desktop.sendSecureAttention") }}
        </UiButton>
        <PopoverTrigger :as="UiButton" variant="ghost" size="icon" :portal-to="stage ?? undefined" :label="t('desktop.settings')" :disabled="!capabilities"><SlidersHorizontal :size="16" :stroke-width="1.75" aria-hidden="true" /></PopoverTrigger>
        <UiButton variant="danger" v-if="stream && active" type="button" class="py-1" @click="connection.disconnect()">
          <Unplug :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t("desktop.disconnect") }}
        </UiButton>

        <!-- Stay inside the fullscreen stage, including nested select portals. -->
        <PopoverPortal :to="stage ?? undefined">
        <PopoverContent :side="settingsSide.above ? 'top' : 'bottom'" :align="settingsSide.alignStart ? 'start' : 'end'" :side-offset="8" :collision-boundary="stage" :collision-padding="12" :aria-label="t('desktop.settings')" class="ui-menu z-50 flex w-72 flex-col gap-3 p-3">
          <ErrorNotice v-if="settingsFailure" :title="t('desktop.settingsFailed')" :error="settingsFailure.error ?? settingsFailure.detail">
            <UiButton size="sm" @click="applySettings">{{ t("errors.retry") }}</UiButton>
          </ErrorNotice>
          <label v-if="capabilities?.displays.length" class="flex flex-col gap-1.5 text-[13px] text-ui-text-muted">
            {{ t("desktop.display") }}
            <UiSelect :model-value="String(displayId ?? '')" :options="capabilities.displays.map(display => ({ value: String(display.id), label: t('desktop.displayOption', { id: display.id, width: display.width, height: display.height }) }))" :portal-to="stage ?? undefined" :aria-label="t('desktop.display')" @update:model-value="displayId = Number($event)" />
          </label>
          <p v-if="chosenCodec" class="m-0 text-[13px] text-ui-text-muted" data-desktop-codec>{{ t("desktop.codecStatus", { codec: codecLabel }) }}</p>
          <label v-if="capabilities?.audio" class="flex items-center gap-2 text-[13px]">
            <UiCheckbox v-model="audio" data-desktop-audio />
            {{ t("desktop.audio") }}
          </label>
          <label class="flex items-center gap-2 text-[13px]">
            <UiCheckbox v-model="control" data-desktop-control />
            {{ t("desktop.control") }}
          </label>
        </PopoverContent>
        </PopoverPortal>
      </div>
      </PopoverRoot>

      <p v-if="fullscreenError" role="alert" class="ui-notice absolute bottom-3 left-3 m-0 border-ui-danger/30 bg-ui-surface text-ui-danger">{{ t("desktop.fullscreenFailed") }}</p>
    </div>
  </div>
</template>
