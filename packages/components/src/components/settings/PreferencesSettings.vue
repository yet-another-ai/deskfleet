<script setup lang="ts">
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { useI18n } from "vue-i18n"
import AutoDownloadUpdatesSettings from "./AutoDownloadUpdatesSettings.vue"
import KeepAwakeSettings from "./KeepAwakeSettings.vue"
import LaunchAtStartupSettings from "./LaunchAtStartupSettings.vue"
import LocalAgentSettings from "./LocalAgentSettings.vue"
import WorktreeRootSettings from "./WorktreeRootSettings.vue"
import RemoteAgentSettings from "./RemoteAgentSettings.vue"
import DictationSettings from "./DictationSettings.vue"

const client = usePlatformClient()

const { t } = useI18n()
</script>

<template>
  <h1 class="ui-page-title mb-6">{{ t("settings.preferences") }}</h1>
  <section class="mb-6" aria-labelledby="input-settings-heading">
    <h2 id="input-settings-heading" class="ui-section-title mb-2">{{ t("dictation.inputSettings") }}</h2>
    <div class="ui-card"><DictationSettings /></div>
  </section>
  <section v-if="client.platform !== 'web'" aria-labelledby="this-computer-heading">
    <h2 id="this-computer-heading" class="ui-section-title mb-2">{{ t("settings.thisComputer") }}</h2>
    <div class="ui-card">
      <LaunchAtStartupSettings />
      <KeepAwakeSettings />
      <AutoDownloadUpdatesSettings />
      <WorktreeRootSettings />
      <RemoteAgentSettings />
      <LocalAgentSettings />
    </div>
  </section>
  <section v-else-if="client.updates" aria-labelledby="updates-heading">
    <h2 id="updates-heading" class="ui-section-title mb-2">{{ t("updatesSettings.title") }}</h2>
    <div class="ui-card">
      <AutoDownloadUpdatesSettings />
    </div>
  </section>
</template>
