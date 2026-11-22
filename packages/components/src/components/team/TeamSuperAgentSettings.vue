<script setup lang="ts">
import { useAsyncState } from "@vueuse/core"
import { useId } from "vue"
import { useI18n } from "vue-i18n"
import type { CentralApi, Machine } from "@deskfleet/client/central"
import type { SuperAgentConfig } from "@deskfleet/client/super-agent"
import ErrorNotice from "../common/ErrorNotice.vue"
import UiButton from "../common/UiButton.vue"
import SuperAgentConfigForm from "../super-agent/SuperAgentConfigForm.vue"

const props = defineProps<{
  api: Pick<CentralApi, "superAgentConfig" | "updateSuperAgentConfig" | "catalog" | "rpc">
  teamId: string
  machines: readonly Machine[]
  localMachineId?: string
}>()
const { t } = useI18n()
const id = useId()
const { state: config, isLoading: loading, error: loadError, executeImmediate: load } = useAsyncState(
  () => props.api.superAgentConfig(props.teamId),
  undefined,
)
function onSaved(updated: SuperAgentConfig): void {
  config.value = updated
}
</script>

<template>
  <section :aria-labelledby="`${id}-title`">
    <h2 :id="`${id}-title`" class="ui-section-title mb-2">{{ t("superAgent.configTitle") }}</h2>
    <p class="m-0 mb-4 text-[13px] text-ui-text-muted">{{ t("superAgent.configDescription") }}</p>
    <p v-if="loading" role="status" class="text-sm text-ui-text-muted">{{ t("welcome.loading") }}</p>
    <div v-else-if="loadError" class="flex flex-col items-start gap-2">
      <ErrorNotice :error="loadError" :title="t('superAgent.configError')" />
      <UiButton type="button" size="sm" @click="load()">{{ t("errors.retry") }}</UiButton>
    </div>
    <SuperAgentConfigForm
      v-else-if="config"
      :team-id="teamId"
      :config="config"
      :machines="machines"
      :local-machine-id="localMachineId"
      :api="api"
      @saved="onSaved"
    />
  </section>
</template>
