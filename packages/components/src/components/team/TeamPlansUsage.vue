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
  { relayedBytes: "0", activeSessionCount: 0, memberCount: 0 },
)
const metrics = computed(() => [
  { key: "traffic", label: t("team.relayedTraffic"), hint: t("team.relayedTrafficHint"), period: t("team.usageAllTime"), amount: fileSize(Number(state.value.relayedBytes)) },
  { key: "sessions", label: t("team.activeSessions"), hint: t("team.activeSessionsHint"), period: t("team.usageCurrent"), amount: String(state.value.activeSessionCount) },
  { key: "members", label: t("team.usageMembers"), hint: t("team.usageMembersHint"), period: t("team.usageCurrent"), amount: String(state.value.memberCount) },
])
</script>

<template>
  <section :aria-labelledby="`${id}-title`" class="mb-8">
    <h2 :id="`${id}-title`" class="ui-section-title mb-2">{{ t("team.plansUsage") }}</h2>
    <p v-if="isLoading" role="status" class="ui-card m-0 p-4 text-sm text-ui-text-muted">{{ t("team.usageLoading") }}</p>
    <div v-else-if="error" class="ui-card flex items-center justify-between gap-4 p-4">
      <p role="alert" class="m-0 text-sm text-ui-danger">{{ t("team.usageError") }}</p>
      <UiButton class="shrink-0" @click="executeImmediate()">{{ t("team.usageRetry") }}</UiButton>
    </div>
    <div v-else-if="isReady" class="grid gap-3">
      <div v-for="metric in metrics" :key="metric.key" :data-team-usage="metric.key" class="ui-card p-4">
        <div class="mb-4 flex items-center justify-between gap-4">
          <div>
            <div class="flex items-center gap-1">
              <h3 :id="`${id}-${metric.key}`" class="m-0 text-sm font-medium">{{ metric.label }}</h3>
              <IconButton :icon="Info" :label="metric.hint" class="-my-1" />
            </div>
            <p class="m-0 mt-1 text-xs text-ui-text-muted">{{ metric.period }}</p>
          </div>
          <span class="ui-badge shrink-0">{{ t("team.unlimited") }}</span>
        </div>
        <p class="m-0 mb-2 text-sm tabular-nums" data-team-usage-amount>{{ metric.amount }} / ∞</p>
        <div role="progressbar" :aria-labelledby="`${id}-${metric.key}`" :aria-valuetext="t('team.usageSummary', { used: metric.amount })" class="h-1.5 rounded-full bg-ui-hover" />
      </div>
    </div>
  </section>
</template>
