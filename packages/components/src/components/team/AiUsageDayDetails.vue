<script setup lang="ts">
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import { X } from "@lucide/vue"
import { useAsyncState } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import UiButton from "../common/UiButton.vue"

const props = defineProps<{ teamId: string; date: string; timeZone: string }>()
const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const central = useAccountSession()!.central
const { state, error, isLoading, executeImmediate: load } = useAsyncState(
  () => central.aiUsageSessions(props.teamId, { date: props.date, timeZone: props.timeZone }), undefined, { onError: () => {} },
)
const number = (value: number) => new Intl.NumberFormat(intlLocale(locale.value as AppLocale)).format(value)
const dateLabel = () => new Intl.DateTimeFormat(intlLocale(locale.value as AppLocale), { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${props.date}T00:00:00Z`))
</script>

<template>
  <section class="mt-5 border-t border-ui-border pt-5" data-ai-usage-detail>
    <div class="mb-3 flex items-center justify-between gap-4">
      <h3 class="text-sm font-medium">{{ dateLabel() }}</h3>
      <UiButton variant="ghost" size="icon" :aria-label="t('aiUsage.closeDetails')" @click="emit('close')"><X :size="16" /></UiButton>
    </div>
    <p v-if="isLoading" role="status" class="py-5 text-sm text-ui-text-muted">{{ t("team.usageLoading") }}</p>
    <div v-else-if="error" class="flex items-center justify-between gap-3">
      <p role="alert" class="text-sm text-ui-danger">{{ t("team.usageError") }}</p>
      <UiButton size="sm" @click="load()">{{ t("team.usageRetry") }}</UiButton>
    </div>
    <template v-else-if="state">
      <p v-if="!state.sessions.length" class="py-5 text-sm text-ui-text-muted">{{ t("aiUsage.noSessions") }}</p>
      <ul v-else class="divide-y divide-ui-border">
        <li v-for="session in state.sessions" :key="`${session.machineId}:${session.sessionId}`" class="flex items-center justify-between gap-4 py-3">
          <div class="min-w-0">
            <p class="truncate text-sm font-medium">{{ session.title || t("aiUsage.untitledSession") }}</p>
            <p class="mt-1 truncate text-xs text-ui-text-muted">{{ session.machineName }} · {{ t("aiUsage.coverage", { reported: number(session.reportedTurnCount), turns: number(session.turnCount) }) }}</p>
          </div>
          <div class="shrink-0 text-right">
            <p class="text-sm font-medium tabular-nums">{{ session.reportedTurnCount ? number(session.totalTokens) : "—" }}</p>
            <p class="mt-1 text-xs text-ui-text-muted">{{ session.reportedTurnCount ? t("aiUsage.tokens") : t("aiUsage.unreported") }}</p>
          </div>
        </li>
      </ul>
      <p v-if="state.truncated" class="mt-3 text-xs text-ui-text-muted">{{ t("aiUsage.sessionsTruncated", { count: state.sessions.length }) }}</p>
    </template>
  </section>
</template>
