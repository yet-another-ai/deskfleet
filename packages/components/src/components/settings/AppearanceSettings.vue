<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { DEFAULT_INTERFACE_FONT, DEFAULT_TERMINAL_FONT, type AppearanceSettings } from "@deskfleet/client/appearance"
import { useAppearanceStore } from "../../stores/appearance.ts"
import UiButton from "../common/UiButton.vue"
import UiSelect from "../common/UiSelect.vue"
import UiSwitch from "../common/UiSwitch.vue"
import AppearanceThemePicker from "./AppearanceThemePicker.vue"
import AppearanceTerminalPreview from "./AppearanceTerminalPreview.vue"

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

onMounted(() => { void appearance.initialize() })
</script>

<template>
  <h1 class="ui-page-title mb-6">{{ t("settings.appearance") }}</h1>
  <section :aria-label="t('settings.appearance')">
    <div>
      <h2 class="mb-2 mt-0 text-sm font-medium">{{ t("appearance.theme") }}</h2>
      <AppearanceThemePicker :model-value="appearance.settings.theme" :disabled="busy" @update:model-value="appearance.set({ theme: $event })" />
    </div>

    <div class="my-5 flex items-center justify-between gap-6 border-y border-ui-border py-4">
      <span id="appearance-language-label" class="text-sm font-medium">{{ t("appearance.language") }}</span>
      <UiSelect name="appearance-language" aria-labelledby="appearance-language-label" class="w-44" :model-value="appearance.settings.language" :options="languages" :disabled="busy" @update:model-value="appearance.set({ language: $event as AppearanceSettings['language'] })" />
    </div>

    <div class="interface-font-row">
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
      <div data-interface-font-preview class="interface-font-sample" :style="{ fontFamily: interfaceFont.trim() || DEFAULT_INTERFACE_FONT }">
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
      <AppearanceTerminalPreview :font-family="terminalFont.trim() || DEFAULT_TERMINAL_FONT" :ligatures="appearance.settings.terminalLigatures" />
      <div class="flex items-center justify-between gap-6 py-4">
        <div>
          <div id="appearance-terminal-ligatures-label" class="text-[13px] font-medium">{{ t("appearance.ligatures") }}</div>
          <p id="appearance-terminal-ligatures-description" class="mb-0 mt-1 text-xs text-ui-text-muted">{{ t("appearance.ligaturesHint") }}</p>
        </div>
        <UiSwitch :model-value="appearance.settings.terminalLigatures" :disabled="busy" aria-labelledby="appearance-terminal-ligatures-label" aria-describedby="appearance-terminal-ligatures-description" @update:model-value="appearance.set({ terminalLigatures: $event })" />
      </div>
    </div>
    <p v-if="!appearance.ready && !appearance.error || appearance.saving" role="status" class="m-0 mt-2 text-[13px] text-ui-text-muted">{{ appearance.saving ? t("catalog.saving") : t("settings.loading") }}</p>
    <p v-if="appearance.error" role="alert" class="m-0 mt-2 break-words text-[13px] text-ui-danger">{{ appearance.error }}</p>
    <UiButton v-if="!appearance.ready && appearance.error" class="mt-2" @click="appearance.initialize()">{{ t("settings.retryLoad") }}</UiButton>
  </section>
</template>

<style scoped>
.interface-font-row { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); align-items: center; gap: 24px; }
.interface-font-sample { display: flex; flex-direction: column; justify-content: center; align-self: stretch; min-width: 0; padding: 12px 16px; border: 1px solid var(--ui-color-border); border-radius: 10px; background: var(--ui-color-surface); overflow-wrap: anywhere; }
</style>
