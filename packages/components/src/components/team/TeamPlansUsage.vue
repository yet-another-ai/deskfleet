<script setup lang="ts">
import { Info } from "@lucide/vue"
import { useAsyncState } from "@vueuse/core"
import { computed, useId } from "vue"
import { useI18n } from "vue-i18n"
import type { Team } from "@deskfleet/client/central"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { fileSize } from "../../services/file-format.ts"
import UiButton from "../common/UiButton.vue"
import IconButton from "../common/IconButton.vue"

const props = defineProps<{ team: Team }>()
const { t } = useI18n()
const id = useId()
const central = useAccountSession()!.central
const { state, isLoading, isReady, error, executeImmediate } = useAsyncState(
  () => central.teamUsage(props.team.id),
  { relayedBytes: "0" },
)
const amount = computed(() => fileSize(Number(state.value.relayedBytes)))
</script>

<template>
  <section :aria-labelledby="`${id}-title`" class="mb-8">
    <h2 :id="`${id}-title`" class="ui-section-title mb-2">{{ t("team.plansUsage") }}</h2>
    <div class="ui-card p-4">
      <div class="mb-4 flex items-center justify-between gap-4">
        <div>
          <div class="flex items-center gap-1">
            <h3 :id="`${id}-traffic`" class="m-0 text-sm font-medium">{{ t("team.relayedTraffic") }}</h3>
            <IconButton :icon="Info" :label="t('team.relayedTrafficHint')" class="-my-1" />
          </div>
          <p class="m-0 mt-1 text-xs text-ui-text-muted">{{ t("team.usageAllTime") }}</p>
        </div>
        <span class="ui-badge shrink-0">{{ t("team.unlimited") }}</span>
      </div>
      <p v-if="isLoading" role="status" class="m-0 text-sm text-ui-text-muted">{{ t("team.usageLoading") }}</p>
      <div v-else-if="error" class="flex items-center justify-between gap-4">
        <p role="alert" class="m-0 text-sm text-ui-danger">{{ t("team.usageError") }}</p>
        <UiButton class="shrink-0" @click="executeImmediate()">{{ t("team.usageRetry") }}</UiButton>
      </div>
      <template v-else-if="isReady">
        <p class="m-0 mb-2 text-sm tabular-nums" data-team-usage-amount>{{ amount }} / ∞</p>
        <div role="progressbar" :aria-labelledby="`${id}-traffic`" :aria-valuetext="t('team.usageSummary', { used: amount })" class="h-1.5 rounded-full bg-ui-hover" />
      </template>
    </div>
  </section>
</template>
