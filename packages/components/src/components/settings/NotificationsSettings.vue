<script setup lang="ts">
import { client } from "@deskfleet/client/platform"
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { NotificationSettings } from "../../../../client/src/settings.ts"
import SettingsRow from "./SettingsRow.vue"

const { t } = useI18n()
const settings = ref<NotificationSettings | null>(null)
const loading = ref(true)
const saving = ref(false)
const requestError = ref<string | null>(null)
const busy = computed(() => loading.value || saving.value)
const options = [
  { key: "enabled", label: "settings.notificationsEnabled", description: "settings.notificationsDescription" },
  { key: "taskCompleted", label: "settings.notificationTaskCompleted", description: "settings.notificationTaskCompletedDescription" },
  { key: "taskNeedsInput", label: "settings.notificationTaskNeedsInput", description: "settings.notificationTaskNeedsInputDescription" },
] as const

async function load() {
  loading.value = true
  requestError.value = null
  try {
    settings.value = await client.settings.getNotifications()
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error)
  } finally { loading.value = false }
}

async function toggle(key: keyof NotificationSettings) {
  if (!settings.value) return
  saving.value = true
  requestError.value = null
  try {
    settings.value = await client.settings.setNotifications({ ...settings.value, [key]: !settings.value[key] })
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error)
  } finally { saving.value = false }
}

onMounted(() => { if (client.platform !== "web") void load() })
</script>

<template>
  <h1 class="ui-page-title mb-6">{{ t("settings.notifications") }}</h1>
  <section v-if="client.platform !== 'web'" :aria-label="t('settings.notifications')">
    <div class="ui-card px-4">
      <SettingsRow v-for="option in options" :key="option.key" :label="t(option.label)" :label-id="`notifications-${option.key}-label`" :description-id="`notifications-${option.key}-description`">
        <template #description>{{ t(option.description) }}</template>
        <button
          type="button"
          role="switch"
          :aria-labelledby="`notifications-${option.key}-label`"
          :aria-describedby="`notifications-${option.key}-description`"
          :aria-checked="settings?.[option.key] ?? false"
          :disabled="busy || !settings || (option.key !== 'enabled' && !settings.enabled)"
          class="ui-switch ml-2 disabled:cursor-default"
          @click="toggle(option.key)"
        >
          <span class="ui-switch-thumb" :class="settings?.[option.key] && 'translate-x-4'" />
        </button>
      </SettingsRow>
    </div>
    <p v-if="busy" role="status" class="m-0 mt-2 text-[13px] text-ui-text-muted">{{ loading ? t("settings.loading") : t("catalog.saving") }}</p>
    <p v-if="requestError" role="alert" class="m-0 mt-2 break-words text-[13px] text-ui-danger">{{ requestError }}</p>
    <button v-if="!settings && requestError" type="button" class="ui-button mt-2" :disabled="busy" @click="load">{{ t("settings.retryLoad") }}</button>
  </section>
</template>
