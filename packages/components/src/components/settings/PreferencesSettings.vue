<script setup lang="ts">
import { readMarketingAttribution } from "@deskfleet/client/marketing-attribution"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import AutoDownloadUpdatesSettings from "./AutoDownloadUpdatesSettings.vue"
import KeepAwakeSettings from "./KeepAwakeSettings.vue"
import LaunchAtStartupSettings from "./LaunchAtStartupSettings.vue"
import LocalAgentSettings from "./LocalAgentSettings.vue"
import RemoteAgentSettings from "./RemoteAgentSettings.vue"
import DictationSettings from "./DictationSettings.vue"
import { useRunningSendBehavior } from "../../composables/useRunningSendBehavior.ts"
import { setUserTelemetryConsent, userTelemetryConsent } from "../../services/analytics.ts"
import UiSelect from "../common/UiSelect.vue"
import UiSwitch from "../common/UiSwitch.vue"
import SettingsRow from "./SettingsRow.vue"

const client = usePlatformClient()
const session = useAccountSession()

const { t } = useI18n()
const runningSendBehavior = useRunningSendBehavior()
const showWebUpdatesSection = ref(false)
const telemetryConsent = computed({
  get: () => userTelemetryConsent.value,
  set: (value: boolean) => {
    setUserTelemetryConsent(value)
    if (session?.account.value.user) {
      void session.central.updateTelemetryConsent?.({
        consented: value,
        ...(value ? { attribution: readMarketingAttribution(true) } : {}),
      })?.catch(() => {})
    }
  },
})
if (client.platform === "web" && client.updates) {
  onMounted(async () => {
    try {
      const state = await client.settings.getAutoDownloadUpdates()
      showWebUpdatesSection.value = state.installSource === "google_play"
    } catch {
      showWebUpdatesSection.value = false
    }
  })
}
</script>

<template>
  <h1 class="ui-page-title mb-6">{{ t("settings.preferences") }}</h1>
  <section class="mb-6" aria-labelledby="input-settings-heading">
    <h2 id="input-settings-heading" class="ui-section-title mb-2">{{ t("dictation.inputSettings") }}</h2>
    <div class="ui-card">
      <SettingsRow :label="t('composer.runningSend.label')" label-id="running-send-label" description-id="running-send-description">
        <template #description>{{ t("composer.runningSend.description") }}</template>
        <UiSelect v-model="runningSendBehavior" :options="[{ value: 'backlog', label: t('agent.addToBacklog') }, { value: 'steer', label: t('agent.steer') }]" aria-labelledby="running-send-label" aria-describedby="running-send-description" class="min-w-44" data-running-send-setting />
      </SettingsRow>
      <DictationSettings />
    </div>
  </section>
  <section v-if="session?.site.value?.telemetryEnabled" class="mb-6" aria-labelledby="privacy-settings-heading">
    <h2 id="privacy-settings-heading" class="ui-section-title mb-2">{{ t("settings.privacyAndAnalytics") }}</h2>
    <div class="ui-card">
      <SettingsRow :label="t('settings.telemetryConsent')" label-id="telemetry-consent-label" description-id="telemetry-consent-description">
        <template #description>{{ t("settings.telemetryConsentDescription") }}</template>
        <UiSwitch v-model="telemetryConsent" aria-labelledby="telemetry-consent-label" aria-describedby="telemetry-consent-description" name="telemetry-consent" />
      </SettingsRow>
    </div>
  </section>
  <section v-if="client.platform !== 'web'" aria-labelledby="this-computer-heading">
    <h2 id="this-computer-heading" class="ui-section-title mb-2">{{ t("settings.thisComputer") }}</h2>
    <div class="ui-card">
      <LaunchAtStartupSettings />
      <KeepAwakeSettings />
      <AutoDownloadUpdatesSettings />
      <RemoteAgentSettings />
      <LocalAgentSettings />
    </div>
  </section>
  <section v-else-if="showWebUpdatesSection" aria-labelledby="updates-heading">
    <h2 id="updates-heading" class="ui-section-title mb-2">{{ t("updatesSettings.title") }}</h2>
    <div class="ui-card">
      <AutoDownloadUpdatesSettings />
    </div>
  </section>
</template>
