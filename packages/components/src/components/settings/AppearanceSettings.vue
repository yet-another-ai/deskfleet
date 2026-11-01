<script setup lang="ts">
import { MessageSquare } from "@lucide/vue"
import { computed, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { DEFAULT_INTERFACE_FONT, DEFAULT_TERMINAL_FONT, type AppearanceSettings } from "@deskfleet/client/appearance"
import { useAppearanceStore } from "../../stores/appearance.ts"
import UiButton from "../common/UiButton.vue"
import UiNumberField from "../common/UiNumberField.vue"
import UiSelect from "../common/UiSelect.vue"
import UiSwitch from "../common/UiSwitch.vue"
import AgentOutline from "../session/AgentOutline.vue"
import AppearanceThemePicker from "./AppearanceThemePicker.vue"
import AppearanceTerminalPreview from "./AppearanceTerminalPreview.vue"
import AppearanceTerminalColors from "./AppearanceTerminalColors.vue"

const { t } = useI18n()
const appearance = useAppearanceStore()
const busy = computed(() => !appearance.ready || appearance.saving)
const interfaceFont = ref(appearance.settings.interfaceFont)
const terminalFont = ref(appearance.settings.terminalFont)
watch(() => appearance.settings.interfaceFont, value => { interfaceFont.value = value })
watch(() => appearance.settings.terminalFont, value => { terminalFont.value = value })

const languages = computed(() => [
  { value: "system", label: t("appearance.followSystem") },
  { value: "en-US", label: "English" },
  { value: "zh-cmn-Hans-CN", label: "简体中文" },
  { value: "ja-JP", label: "日本語" },
])

function saveFont(key: "interfaceFont" | "terminalFont"): void {
  const value = key === "interfaceFont" ? interfaceFont.value : terminalFont.value
  if (value !== appearance.settings[key]) void appearance.set({ [key]: value })
}

function saveOutlineNumber(key: "outlineAudioMaxWidth" | "outlineAudioDecayMs", value: number): void {
  if (!Number.isFinite(value) || value < 0) return
  if (value !== appearance.settings[key]) void appearance.set({ [key]: value })
}

onMounted(() => { void appearance.initialize() })
</script>

<template>
  <h1 class="ui-page-title mb-6">{{ t("settings.appearance") }}</h1>
  <section :aria-label="t('settings.appearance')">
    <div>
      <h2 class="mb-2 mt-0 text-sm font-medium">{{ t("appearance.theme") }}</h2>
      <AppearanceThemePicker :model-value="appearance.settings.theme" :disabled="busy" @update:model-value="appearance.set({ theme: $event })" />
    </div>

    <div class="my-5 flex flex-wrap items-center justify-between gap-3 border-y border-ui-border py-4 sm:gap-6">
      <span id="appearance-language-label" class="text-sm font-medium">{{ t("appearance.language") }}</span>
      <UiSelect name="appearance-language" aria-labelledby="appearance-language-label" class="w-44" :model-value="appearance.settings.language" :options="languages" :disabled="busy" @update:model-value="appearance.set({ language: $event as AppearanceSettings['language'] })" />
    </div>

    <div class="grid items-center gap-6 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div class="min-w-0">
        <label for="appearance-interface-font" class="mb-2 block text-sm font-medium">{{ t("appearance.interfaceFont") }}</label>
        <input
          id="appearance-interface-font" v-model="interfaceFont" name="appearance-interface-font" type="text"
          class="ui-input w-full text-[13px]" :placeholder="t('appearance.defaultFont')" :disabled="busy"
          aria-describedby="appearance-interface-font-description" spellcheck="false"
          @change="saveFont('interfaceFont')" @keydown.enter.prevent="saveFont('interfaceFont')"
        >
        <p id="appearance-interface-font-description" class="mb-0 mt-2 text-xs leading-relaxed text-ui-text-muted">{{ t("appearance.fontHint") }}</p>
      </div>
      <div data-interface-font-preview class="flex min-w-0 flex-col justify-center self-stretch break-words rounded-[10px] border border-ui-border bg-ui-surface px-4 py-3" :style="{ fontFamily: interfaceFont.trim() || DEFAULT_INTERFACE_FONT }">
        <span class="text-[30px] leading-none tracking-tight text-ui-text">Aa <span class="text-[24px]">字</span></span>
        <span class="mt-2 text-xs leading-relaxed text-ui-text-muted">{{ t("appearance.interfacePreview") }}</span>
      </div>
    </div>

    <div class="mt-6 border-t border-ui-border pt-5">
      <label for="appearance-terminal-font" class="mb-2 block text-sm font-medium">{{ t("appearance.terminalFont") }}</label>
      <input
        id="appearance-terminal-font" v-model="terminalFont" name="appearance-terminal-font" type="text"
        class="ui-input w-full font-mono text-[13px]" :placeholder="t('appearance.defaultFont')" :disabled="busy"
        aria-describedby="appearance-terminal-font-description" spellcheck="false"
        @change="saveFont('terminalFont')" @keydown.enter.prevent="saveFont('terminalFont')"
      >
      <p id="appearance-terminal-font-description" class="mb-3 mt-2 text-xs leading-relaxed text-ui-text-muted">{{ t("appearance.terminalFontHint") }}</p>
      <div class="flex items-center justify-between gap-6 py-4">
        <div>
          <div id="appearance-terminal-ligatures-label" class="text-[13px] font-medium">{{ t("appearance.ligatures") }}</div>
          <p id="appearance-terminal-ligatures-description" class="mb-0 mt-1 text-xs text-ui-text-muted">{{ t("appearance.ligaturesHint") }}</p>
        </div>
        <UiSwitch :model-value="appearance.settings.terminalLigatures" :disabled="busy" aria-labelledby="appearance-terminal-ligatures-label" aria-describedby="appearance-terminal-ligatures-description" @update:model-value="appearance.set({ terminalLigatures: $event })" />
      </div>
      <AppearanceTerminalColors :disabled="busy">
        <AppearanceTerminalPreview :font-family="terminalFont.trim() || DEFAULT_TERMINAL_FONT" :ligatures="appearance.settings.terminalLigatures" />
      </AppearanceTerminalColors>
    </div>

    <div class="border-t border-ui-border py-5">
      <div class="flex items-center justify-between gap-6">
        <div>
          <div id="appearance-reading-spotlight-label" class="text-sm font-medium">{{ t("appearance.readingSpotlight") }}</div>
          <p id="appearance-reading-spotlight-description" class="mb-0 mt-1 text-xs leading-relaxed text-ui-text-muted">{{ t("appearance.readingSpotlightHint") }}</p>
        </div>
        <UiSwitch :model-value="appearance.settings.readingSpotlight" :disabled="busy" aria-labelledby="appearance-reading-spotlight-label" aria-describedby="appearance-reading-spotlight-description" @update:model-value="appearance.set({ readingSpotlight: $event })" />
      </div>
    </div>

    <div class="border-t border-ui-border py-5">
      <div class="flex items-center justify-between gap-6">
        <div>
          <div id="appearance-outline-audio-label" class="text-sm font-medium">{{ t("appearance.outlineAudio") }}</div>
          <p id="appearance-outline-audio-description" class="mb-0 mt-1 text-xs leading-relaxed text-ui-text-muted">{{ t("appearance.outlineAudioHint") }}</p>
        </div>
        <UiSwitch :model-value="appearance.settings.outlineAudio" :disabled="busy" aria-labelledby="appearance-outline-audio-label" aria-describedby="appearance-outline-audio-description" @update:model-value="appearance.set({ outlineAudio: $event })" />
      </div>
      <div v-if="appearance.settings.outlineAudio" class="mt-4 flex flex-col gap-4">
        <div data-outline-audio-preview class="overflow-hidden rounded-xl border border-ui-border bg-ui-canvas text-ui-text" :aria-label="t('appearance.preview')">
          <div class="flex h-9 items-center gap-2 border-b border-ui-border bg-ui-surface px-3.5 text-xs text-ui-text-muted">
            <MessageSquare :size="13" :stroke-width="1.75" aria-hidden="true" />
            <span>{{ t("agent.conversation") }}</span>
          </div>
          <div class="flex h-48 overflow-hidden">
            <div aria-hidden="true" class="flex w-32 shrink-0 flex-col gap-2 border-r border-ui-border bg-ui-sidebar p-3">
              <div class="h-2.5 w-14 rounded-full bg-ui-text-muted/20" />
              <div class="mt-1 h-5 w-full rounded-md bg-ui-accent/12" />
              <div class="h-5 w-4/5 rounded-md bg-ui-text-muted/10" />
              <div class="h-5 w-5/6 rounded-md bg-ui-text-muted/10" />
              <div class="h-5 w-3/4 rounded-md bg-ui-text-muted/10" />
            </div>
            <div class="relative flex min-w-0 flex-1 items-center overflow-hidden px-10 py-4">
              <AgentOutline preview class="absolute left-1 top-1/2 z-10 max-h-[calc(100%-2rem)] -translate-y-1/2" />
              <div aria-hidden="true" class="flex h-full w-full flex-col justify-between">
                <div class="h-5 w-32 self-end rounded-xl bg-ui-accent/10" />
                <div class="h-5 w-52 max-w-full self-start rounded-xl bg-ui-text-muted/12" />
                <div class="h-5 w-24 self-end rounded-xl bg-ui-accent/10" />
                <div class="h-5 w-44 max-w-full self-start rounded-xl bg-ui-text-muted/12" />
                <div class="h-5 w-28 self-end rounded-xl bg-ui-accent/10" />
              </div>
            </div>
          </div>
        </div>
        <div class="flex items-center justify-between gap-6">
          <div>
            <div id="appearance-outline-audio-rgb-label" class="text-[13px] font-medium">{{ t("appearance.outlineAudioRgb") }}</div>
            <p id="appearance-outline-audio-rgb-description" class="mb-0 mt-1 text-xs text-ui-text-muted">{{ t("appearance.outlineAudioRgbHint") }}</p>
          </div>
          <UiSwitch
            :model-value="appearance.settings.outlineAudioRgb"
            :disabled="busy"
            aria-labelledby="appearance-outline-audio-rgb-label"
            aria-describedby="appearance-outline-audio-rgb-description"
            @update:model-value="appearance.set({ outlineAudioRgb: $event })"
          />
        </div>
        <div class="flex items-center justify-between gap-6">
          <div>
            <div id="appearance-outline-audio-max-width-label" class="text-[13px] font-medium">{{ t("appearance.outlineAudioMaxWidth") }}</div>
            <p id="appearance-outline-audio-max-width-description" class="mb-0 mt-1 text-xs text-ui-text-muted">{{ t("appearance.outlineAudioMaxWidthHint") }}</p>
          </div>
          <UiNumberField
            name="appearance-outline-audio-max-width"
            :model-value="appearance.settings.outlineAudioMaxWidth"
            :min="0"
            unit="px"
            :disabled="!appearance.ready"
            aria-labelledby="appearance-outline-audio-max-width-label"
            aria-describedby="appearance-outline-audio-max-width-description"
            @update:model-value="saveOutlineNumber('outlineAudioMaxWidth', $event)"
          />
        </div>
        <div class="flex items-center justify-between gap-6">
          <div>
            <div id="appearance-outline-audio-decay-ms-label" class="text-[13px] font-medium">{{ t("appearance.outlineAudioDecayMs") }}</div>
            <p id="appearance-outline-audio-decay-ms-description" class="mb-0 mt-1 text-xs text-ui-text-muted">{{ t("appearance.outlineAudioDecayMsHint") }}</p>
          </div>
          <UiNumberField
            name="appearance-outline-audio-decay-ms"
            :model-value="appearance.settings.outlineAudioDecayMs"
            :min="0"
            unit="ms"
            :disabled="!appearance.ready"
            aria-labelledby="appearance-outline-audio-decay-ms-label"
            aria-describedby="appearance-outline-audio-decay-ms-description"
            @update:model-value="saveOutlineNumber('outlineAudioDecayMs', $event)"
          />
        </div>
      </div>
    </div>
    <p v-if="!appearance.ready && !appearance.error || appearance.saving" role="status" class="m-0 mt-2 text-[13px] text-ui-text-muted">{{ appearance.saving ? t("catalog.saving") : t("settings.loading") }}</p>
    <p v-if="appearance.error" role="alert" class="m-0 mt-2 break-words text-[13px] text-ui-danger">{{ appearance.error }}</p>
    <UiButton v-if="!appearance.ready && appearance.error" class="mt-2" @click="appearance.initialize()">{{ t("settings.retryLoad") }}</UiButton>
  </section>
</template>
