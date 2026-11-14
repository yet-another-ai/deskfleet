<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { useDictationPreference } from "../../composables/useDictationPreference.ts"
import UiSwitch from "../common/UiSwitch.vue"
import SettingsRow from "./SettingsRow.vue"

const { t } = useI18n()
const enabled = useDictationPreference()
</script>

<template>
  <SettingsRow :label="t('dictation.setting')" label-id="dictation-label" description-id="dictation-description">
    <template #description>{{ t("dictation.settingDescription") }}</template>
    <UiSwitch v-model="enabled" aria-labelledby="dictation-label" aria-describedby="dictation-description" data-dictation-setting />
  </SettingsRow>
</template>
