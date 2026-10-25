<script setup lang="ts">
import { client as platformClient } from "@deskfleet/client/platform"

import { GripVertical, LoaderCircle, Maximize, MonitorPlay, Play, RefreshCw, SlidersHorizontal, Unplug } from "@lucide/vue"
import { onClickOutside } from "@vueuse/core"
import { computed, onBeforeUnmount, ref, shallowRef, useId, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { DesktopCapabilities } from "../../../client/src/desktop-media.ts"
import IconButton from "../components/common/IconButton.vue"
import { commonDesktopCodecs, desktopCodecLabel, useDesktopConnection } from "../composables/useDesktopConnection.ts"
import { useFloatingToolbar } from "../composables/useFloatingToolbar.ts"
import { useFleetStore } from "../stores/fleet.ts"

const props = defineProps<{ machineId: string }>()
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
const video = shallowRef<HTMLVideoElement | null>(null)
const playbackBlocked = ref(false)
const fullscreenError = ref(false)
const settingsOpen = ref(false)
const settingsId = useId()
const settingsTrigger = useTemplateRef<{ $el: HTMLButtonElement }>("settingsTrigger")

const stage = useTemplateRef<HTMLElement>("stage")
const toolbar = useTemplateRef<HTMLElement>("toolbar")
let discoveryGeneration = 0

onClickOutside(toolbar, () => { settingsOpen.value = false })
function closeSettings(): void {
  if (!settingsOpen.value) return
  settingsOpen.value = false
  settingsTrigger.value?.$el.focus()
}

// The toolbar can cover any part of the remote screen, so the viewer can move it.
const { position: toolbarPosition, startDrag, moveDrag, endDrag, nudge: nudgeToolbar, panelSide: settingsSide } = useFloatingToolbar(stage, toolbar)

const codecs = computed(() => commonDesktopCodecs(
  capabilities.value?.displays.find(display => display.id === displayId.value)?.codecs ?? [],
  typeof RTCRtpReceiver === "undefined" ? [] : RTCRtpReceiver.getCapabilities("video")?.codecs ?? [],
))
const chosenCodec = computed(() => activeCodec.value ?? codecs.value[0] ?? null)
const codecLabel = computed(() => chosenCodec.value ? desktopCodecLabel(chosenCodec.value) : "")
const active = computed(() => ["connecting", "starting", "connected"].includes(state.value))
const canConnect = computed(() => local.value && !loading.value && !active.value
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
  if (!canConnect.value || displayId.value === null || codecs.value.length === 0) return
  void connection.connect({ displayId: displayId.value, codecs: codecs.value, audio: audio.value })
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
  return t("desktop.ready", { codec: codecLabel.value })
})
const detail = computed(() => local.value ? failure.value?.detail ?? discoveryError.value
  ?? (!fleet.localDesktopTarget.online ? fleet.localDesktopTarget.error : undefined) : undefined)
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The stream fills the pane; its controls and settings float above it. -->
    <div ref="stage" data-desktop-stage class="relative flex min-h-64 min-w-0 flex-1 flex-col items-center justify-center overflow-hidden rounded-xl border transition-colors" :class="stream ? 'border-transparent bg-ui-terminal' : 'border-ui-border bg-ui-surface'">
      <video
        v-if="local"
        v-show="stream"
        ref="video"
        class="absolute inset-0 h-full w-full object-contain"
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
          <button v-if="active" type="button" class="ui-button" @click="connection.disconnect()">{{ t("desktop.disconnect") }}</button>
          <button v-else type="button" class="ui-button-primary" :disabled="!canConnect" @click="connect">{{ t("desktop.connect") }}</button>
          <button type="button" class="ui-text-button cursor-pointer hover:bg-ui-hover hover:text-ui-text disabled:cursor-default disabled:op-40" :disabled="loading || active" @click="refresh">
            <RefreshCw :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t("desktop.retry") }}
          </button>
        </div>
      </div>

      <button v-if="playbackBlocked" type="button" class="ui-button-primary absolute" @click="play">
        <Play :size="14" :stroke-width="2" aria-hidden="true" />{{ t("desktop.play") }}
      </button>

      <div
        v-if="local"
        ref="toolbar"
        class="absolute z-10 flex items-center gap-1 rounded-xl border border-ui-border bg-ui-surface p-1 shadow-ui-popover"
        :class="!toolbarPosition && 'top-3 right-3'"
        :style="toolbarPosition && { left: `${toolbarPosition.x}px`, top: `${toolbarPosition.y}px` }"
        @keydown.esc="closeSettings"
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
        <IconButton v-if="stream && state === 'connected'" :icon="Maximize" :label="t('desktop.fullscreen')" @click="fullscreen" />
        <IconButton ref="settingsTrigger" :icon="SlidersHorizontal" :label="t('desktop.settings')" :disabled="!capabilities" aria-haspopup="dialog" :aria-expanded="settingsOpen" :aria-controls="settingsId" @click="settingsOpen = !settingsOpen" />
        <button v-if="stream && active" type="button" class="ui-button-danger py-1" @click="connection.disconnect()">
          <Unplug :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t("desktop.disconnect") }}
        </button>

        <!-- Kept mounted so the chosen settings persist while the panel is closed. -->
        <div v-show="settingsOpen" :id="settingsId" role="dialog" :aria-label="t('desktop.settings')" class="ui-menu absolute z-20 flex w-72 flex-col gap-3 p-3" :class="[settingsSide.above ? 'bottom-full mb-2' : 'top-full mt-2', settingsSide.alignStart ? 'left-0' : 'right-0']">
          <label v-if="capabilities?.displays.length" class="flex flex-col gap-1.5 text-[13px] text-ui-text-muted">
            {{ t("desktop.display") }}
            <select v-model="displayId" class="ui-input text-ui-text" :disabled="active">
              <option v-for="display in capabilities.displays" :key="display.id" :value="display.id">
                {{ t("desktop.displayOption", { id: display.id, width: display.width, height: display.height }) }}
              </option>
            </select>
          </label>
          <p v-if="chosenCodec" class="m-0 text-[13px] text-ui-text-muted" data-desktop-codec>{{ t("desktop.codecStatus", { codec: codecLabel }) }}</p>
          <label v-if="capabilities?.audio" class="flex items-center gap-2 text-[13px]">
            <input v-model="audio" type="checkbox" :disabled="active" />
            {{ t("desktop.audio") }}
          </label>
          <p v-if="active" class="m-0 text-xs text-ui-text-muted">{{ t("desktop.settingsLocked") }}</p>
        </div>
      </div>

      <p v-if="fullscreenError" role="alert" class="ui-notice absolute bottom-3 left-3 m-0 border-ui-danger/30 bg-ui-surface text-ui-danger">{{ t("desktop.fullscreenFailed") }}</p>
    </div>
  </div>
</template>
