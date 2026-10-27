<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { DEFAULT_INTERFACE_FONT, DEFAULT_TERMINAL_FONT, type AppearanceSettings } from "@deskfleet/client/appearance"
import { useAppearanceStore } from "../../stores/appearance.ts"
import UiButton from "../common/UiButton.vue"
import UiSelect from "../common/UiSelect.vue"
import SettingsRow from "./SettingsRow.vue"

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
])
const themes = computed(() => [
  { value: "system", label: t("appearance.followSystem") },
  { value: "light", label: t("appearance.light") },
  { value: "dark", label: t("appearance.dark") },
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
    <div class="ui-card px-4">
      <SettingsRow :label="t('appearance.language')" label-id="appearance-language-label">
        <UiSelect
          name="appearance-language"
          aria-labelledby="appearance-language-label"
          class="w-44"
          :model-value="appearance.settings.language"
          :options="languages"
          :disabled="busy"
          @update:model-value="appearance.set({ language: $event as AppearanceSettings['language'] })"
        />
      </SettingsRow>
      <SettingsRow :label="t('appearance.theme')" label-id="appearance-theme-label">
        <UiSelect
          name="appearance-theme"
          aria-labelledby="appearance-theme-label"
          class="w-44"
          :model-value="appearance.settings.theme"
          :options="themes"
          :disabled="busy"
          @update:model-value="appearance.set({ theme: $event as AppearanceSettings['theme'] })"
        />
      </SettingsRow>
    </div>
    <h2 class="ui-section-title mb-2 mt-6">{{ t("appearance.fonts") }}</h2>
    <div class="ui-card px-4">
      <div class="ui-setting py-4">
        <label for="appearance-interface-font" class="text-sm">{{ t("appearance.interfaceFont") }}</label>
        <p id="appearance-interface-font-description" class="m-0 mb-3 mt-0.5 text-[13px] text-ui-text-muted">{{ t("appearance.fontHint") }}</p>
        <input
          id="appearance-interface-font"
          v-model="interfaceFont"
          name="appearance-interface-font"
          type="text"
          class="ui-input w-full"
          :placeholder="DEFAULT_INTERFACE_FONT"
          :disabled="busy"
          aria-describedby="appearance-interface-font-description"
          spellcheck="false"
          @change="saveFont('interfaceFont')"
          @keydown.enter.prevent="saveFont('interfaceFont')"
        >
        <p data-interface-font-preview class="mb-0 mt-3 text-sm text-ui-text-muted" :style="{ fontFamily: interfaceFont.trim() || DEFAULT_INTERFACE_FONT }">{{ t("appearance.interfacePreview") }}</p>
      </div>
      <div class="ui-setting py-4">
        <label for="appearance-terminal-font" class="text-sm">{{ t("appearance.terminalFont") }}</label>
        <p id="appearance-terminal-font-description" class="m-0 mb-3 mt-0.5 text-[13px] text-ui-text-muted">{{ t("appearance.terminalFontHint") }}</p>
        <input
          id="appearance-terminal-font"
          v-model="terminalFont"
          name="appearance-terminal-font"
          type="text"
          class="ui-input w-full"
          :placeholder="DEFAULT_TERMINAL_FONT"
          :disabled="busy"
          aria-describedby="appearance-terminal-font-description"
          spellcheck="false"
          @change="saveFont('terminalFont')"
          @keydown.enter.prevent="saveFont('terminalFont')"
        >
        <p data-terminal-font-preview class="mb-0 mt-3 whitespace-pre-wrap text-sm text-ui-text-muted" :style="{ fontFamily: terminalFont.trim() || DEFAULT_TERMINAL_FONT }">{{ t("appearance.terminalPreview") }}</p>
      </div>
    </div>
    <p v-if="!appearance.ready && !appearance.error || appearance.saving" role="status" class="m-0 mt-2 text-[13px] text-ui-text-muted">{{ appearance.saving ? t("catalog.saving") : t("settings.loading") }}</p>
    <p v-if="appearance.error" role="alert" class="m-0 mt-2 break-words text-[13px] text-ui-danger">{{ appearance.error }}</p>
    <UiButton v-if="!appearance.ready && appearance.error" class="mt-2" @click="appearance.initialize()">{{ t("settings.retryLoad") }}</UiButton>
  </section>
</template>
