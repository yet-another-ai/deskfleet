<script setup lang="ts">
import { RefreshCw } from "@lucide/vue"
import UiButton from "../common/UiButton.vue"
import UiSwitch from "../common/UiSwitch.vue"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { useFeatureGate } from "../../services/analytics.ts"
import { getBrowserNotificationPermission, requestBrowserNotificationPermission } from "@deskfleet/client/browser-notifications"
import { useEventListener } from "@vueuse/core"
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { NotificationSettings } from "@deskfleet/client/settings"
import SettingsRow from "./SettingsRow.vue"

const client = usePlatformClient()
const pushNotificationsEnabled = useFeatureGate("mobile_push_notifications")

const { t } = useI18n()
const settings = ref<NotificationSettings | null>(null)
const loading = ref(true)
const saving = ref(false)
const refreshing = ref(false)
const requestError = ref<string | null>(null)
const web = client.platform === "web"
const mobile = Boolean(client.mobile)
const browser = web && !mobile
const available = computed(() => !mobile || pushNotificationsEnabled.value)
const permission = ref(
  browser && !client.settings.getNotificationPermission ? getBrowserNotificationPermission() : undefined,
)
const busy = computed(() => loading.value || saving.value || refreshing.value)
const options = [
  {
    key: "enabled",
    label: mobile ? "settings.mobileNotificationsEnabled" : web ? "settings.browserNotificationsEnabled" : "settings.notificationsEnabled",
    description: mobile ? "settings.mobileNotificationsDescription" : web ? "settings.browserNotificationsDescription" : "settings.notificationsDescription",
  },
  { key: "taskCompleted", label: "settings.notificationTaskCompleted", description: "settings.notificationTaskCompletedDescription" },
  { key: "taskNeedsInput", label: "settings.notificationTaskNeedsInput", description: "settings.notificationTaskNeedsInputDescription" },
] as const

async function readPermission(): Promise<void> {
  if (!available.value) return
  if (client.settings.getNotificationPermission) {
    permission.value = await client.settings.getNotificationPermission()
  } else if (browser) {
    permission.value = getBrowserNotificationPermission()
  }
}

async function refreshPermission(): Promise<void> {
  if (!available.value || busy.value) return
  refreshing.value = true
  requestError.value = null
  try {
    await readPermission()
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error)
  } finally {
    refreshing.value = false
  }
}

async function load() {
  if (!available.value) return
  loading.value = true
  requestError.value = null
  try {
    const [loaded] = await Promise.all([
      client.settings.getNotifications(),
      readPermission(),
    ])
    settings.value = loaded
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error)
  } finally { loading.value = false }
}

async function toggle(key: keyof NotificationSettings) {
  if (!available.value || !settings.value) return
  saving.value = true
  requestError.value = null
  try {
    settings.value = await client.settings.setNotifications({ ...settings.value, [key]: !settings.value[key] })
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error)
  } finally { saving.value = false }
}

async function enablePermission(): Promise<void> {
  if (!available.value || busy.value) return
  saving.value = true
  requestError.value = null
  try {
    permission.value = client.settings.requestNotificationPermission
      ? await client.settings.requestNotificationPermission()
      : await requestBrowserNotificationPermission()
  }
  catch (error) { requestError.value = error instanceof Error ? error.message : String(error) }
  finally { saving.value = false }
}

useEventListener(window, "focus", () => { void readPermission() })
watch(available, value => { if (value && !settings.value) void load() }, { immediate: true })
</script>

<template>
  <h1 class="ui-page-title mb-6">{{ t("settings.notifications") }}</h1>
  <section v-if="available" :aria-label="t('settings.notifications')">
    <div v-if="permission" class="ui-card mb-4 p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="m-0 text-sm font-medium">{{ t(browser ? "settings.notificationPermission" : "settings.mobileNotificationPermission") }}</p>
        <div class="flex flex-wrap gap-2">
          <UiButton v-if="permission === 'default'" type="button" :disabled="busy" @click="enablePermission">{{ t("settings.enableBrowserNotifications") }}</UiButton>
          <UiButton v-else-if="!web && permission === 'denied'" type="button" :disabled="busy" @click="enablePermission">{{ t("welcome.permissions.localNetwork.openSettings") }}</UiButton>
          <UiButton type="button" :disabled="busy" @click="refreshPermission">
            <RefreshCw :size="14" :class="refreshing && 'animate-spin'" aria-hidden="true" />
            {{ t(refreshing ? "permissionsSettings.refreshing" : "permissionsSettings.refresh") }}
          </UiButton>
        </div>
      </div>
      <p role="status" class="m-0 mt-2 text-[13px] leading-relaxed" :class="permission === 'granted' ? 'text-ui-success' : 'text-ui-text-muted'">{{ t(`${browser ? "settings.notificationPermissionStatus" : "settings.mobileNotificationPermissionStatus"}.${permission}`) }}</p>
    </div>
    <div class="ui-card">
      <SettingsRow v-for="option in options" :key="option.key" :label="t(option.label)" :label-id="`notifications-${option.key}-label`" :description-id="`notifications-${option.key}-description`">
        <template #description>{{ t(option.description) }}</template>
        <UiSwitch
          :aria-labelledby="`notifications-${option.key}-label`"
          :aria-describedby="`notifications-${option.key}-description`"
          :model-value="settings?.[option.key] ?? false"
          :disabled="busy || !settings || (option.key !== 'enabled' && !settings.enabled)"
          class="ml-2 disabled:cursor-default"
          @update:model-value="toggle(option.key)"
         />
      </SettingsRow>
    </div>
    <p v-if="busy" role="status" class="m-0 mt-2 text-[13px] text-ui-text-muted">{{ loading ? t("settings.loading") : t("catalog.saving") }}</p>
    <p v-if="requestError" role="alert" class="m-0 mt-2 break-words text-[13px] text-ui-danger">{{ requestError }}</p>
    <UiButton v-if="!settings && requestError" type="button" class="mt-2" :disabled="busy" @click="load">{{ t("settings.retryLoad") }}</UiButton>
  </section>
</template>
