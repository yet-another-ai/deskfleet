<script setup lang="ts">
import type { AiUsagePeriod } from "@deskfleet/client/ai-usage"
import type { Team } from "@deskfleet/client/central"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import { Activity, ArrowDownLeft, ArrowUpRight, Database, RefreshCw } from "@lucide/vue"
import { useAsyncState } from "@vueuse/core"
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { calendarDate, usageStatistics } from "../../services/team-ai-usage.ts"
import UiButton from "../common/UiButton.vue"
import AiUsageBreakdown from "./AiUsageBreakdown.vue"
import AiUsageDayDetails from "./AiUsageDayDetails.vue"
import AiUsageHeatmap from "./AiUsageHeatmap.vue"

const props = defineProps<{ team: Team }>()
const { t, locale } = useI18n()
const central = useAccountSession()!.central
const period = ref<AiUsagePeriod>("30d")
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const selectedDay = ref<string>()
const periods: AiUsagePeriod[] = ["24h", "7d", "30d", "all"]
const { state, error, isLoading, executeImmediate: load } = useAsyncState(
  () => central.aiUsage(props.team.id, { period: period.value, timeZone }), undefined, { onError: () => {} },
)
watch(period, () => { selectedDay.value = undefined; void load() })
const reported = computed(() => (state.value?.totals.reportedTurnCount ?? 0) > 0)
const stats = computed(() => usageStatistics(state.value?.buckets ?? [], state.value))
const formatLocale = computed(() => intlLocale(locale.value as AppLocale))
const number = (value: number) => new Intl.NumberFormat(formatLocale.value, { maximumFractionDigits: 0 }).format(value)
const compact = (value: number) => new Intl.NumberFormat(formatLocale.value, { notation: "compact", maximumFractionDigits: 1 }).format(value)
const metric = (value: number | null) => reported.value && value !== null ? compact(value) : "—"
const date = (value: string, full = false) => new Intl.DateTimeFormat(formatLocale.value, {
  timeZone, ...(full ? { dateStyle: "medium", timeStyle: "short" } : { month: "short", day: "numeric", ...(period.value === "24h" ? { hour: "numeric" } : {}) }),
}).format(new Date(value))
const rangeStart = computed(() => state.value ? calendarDate(state.value.from, timeZone) : "")
const rangeEnd = computed(() => state.value ? calendarDate(state.value.to, timeZone) : "")
</script>

<template>
  <div class="flex flex-col gap-6 pb-6" data-team-ai-usage>
    <header class="flex flex-wrap items-end justify-between gap-5">
      <div class="min-w-0">
        <h1 class="ui-page-title">{{ t("aiUsage.title") }}</h1>
        <p class="mt-2 truncate text-sm text-ui-text-muted">{{ team.name }}</p>
      </div>
      <div class="flex max-w-full items-center gap-2">
        <div class="flex rounded-lg border border-ui-border bg-ui-hover p-1" role="group" :aria-label="t('aiUsage.period')">
          <button v-for="value in periods" :key="value" type="button" :data-usage-period="value" :aria-pressed="period === value" class="cursor-pointer whitespace-nowrap rounded-md px-3 py-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ui-accent sm:px-4" :class="period === value ? 'bg-ui-surface text-ui-text shadow-sm' : 'text-ui-text-muted hover:text-ui-text'" @click="period = value">
            {{ t(`aiUsage.periods.${value}`) }}
          </button>
        </div>
        <UiButton variant="ghost" size="icon" :aria-label="t('aiUsage.refresh')" :disabled="isLoading" @click="load()"><RefreshCw :size="15" :class="isLoading && 'animate-spin'" /></UiButton>
      </div>
    </header>

    <div v-if="isLoading" class="ui-card px-6 py-14 text-center text-sm text-ui-text-muted" role="status">{{ t("team.usageLoading") }}</div>
    <div v-else-if="error" class="ui-card flex items-center justify-between gap-4 p-6">
      <p role="alert" class="text-sm text-ui-danger">{{ t("team.usageError") }}</p>
      <UiButton size="sm" @click="load()">{{ t("team.usageRetry") }}</UiButton>
    </div>
    <template v-else-if="state">
      <div class="grid gap-4 lg:grid-cols-[1.15fr_2fr]">
        <section class="ui-card relative overflow-hidden px-6 py-6">
          <Activity :size="128" :stroke-width="1" class="pointer-events-none absolute -bottom-5 -right-3 text-ui-accent opacity-[0.08]" aria-hidden="true" />
          <h2 class="text-xs font-medium text-ui-text-muted">{{ t("aiUsage.totalTokens") }}</h2>
          <p class="relative mt-4 text-4xl font-medium tracking-tight tabular-nums sm:text-5xl" data-ai-usage-total :title="reported ? number(state.totals.totalTokens) : undefined">{{ metric(state.totals.totalTokens) }}</p>
          <p class="mt-4 text-xs text-ui-text-muted">{{ t(`aiUsage.ranges.${period}`) }}</p>
        </section>
        <section class="ui-card grid grid-cols-2 gap-x-5 gap-y-6 px-6 py-6">
          <div v-for="item in [
            { key: 'input', value: state.totals.inputTokens, icon: ArrowDownLeft },
            { key: 'output', value: state.totals.outputTokens, icon: ArrowUpRight },
            { key: 'cachedRead', value: state.totals.cachedReadTokens, icon: Database },
            { key: 'cachedWrite', value: state.totals.cachedWriteTokens, icon: Database },
          ]" :key="item.key" :data-ai-usage-metric="item.key">
            <h2 class="flex items-center gap-1.5 text-xs text-ui-text-muted"><component :is="item.icon" :size="13" aria-hidden="true" />{{ t(`aiUsage.${item.key}`) }}</h2>
            <p class="mt-2 text-xl font-medium tabular-nums" :title="reported && item.value !== null ? number(item.value) : t('aiUsage.unreported')">{{ metric(item.value) }}</p>
          </div>
        </section>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 text-xs text-ui-text-muted" data-ai-usage-coverage>
        <p>{{ t("aiUsage.coverage", { reported: number(state.totals.reportedTurnCount), turns: number(state.totals.turnCount) }) }}</p>
        <p>{{ state.lastSyncedAt ? t("aiUsage.lastSynced", { date: date(state.lastSyncedAt, true) }) : t("aiUsage.notSynced") }}</p>
      </div>
      <p v-if="!reported" class="rounded-lg bg-ui-hover px-4 py-3 text-sm text-ui-text-muted" data-ai-usage-empty>{{ t(state.totals.turnCount ? "aiUsage.noReports" : "aiUsage.empty") }}</p>

      <section class="ui-card overflow-hidden">
        <div class="p-5 sm:p-6">
          <h2 class="text-sm font-medium">{{ t("aiUsage.heatmap") }}</h2>
          <p class="mb-6 mt-1.5 text-xs text-ui-text-muted">{{ t("aiUsage.heatmapDescription", { range: t(`aiUsage.ranges.${period}`) }) }}</p>
          <AiUsageHeatmap :days="state.heatmap" :from="rangeStart" :to="rangeEnd" :selected="selectedDay" @select="selectedDay = selectedDay === $event ? undefined : $event" />
          <AiUsageDayDetails v-if="selectedDay" :key="selectedDay" :team-id="team.id" :date="selectedDay" :time-zone="timeZone" @close="selectedDay = undefined" />
        </div>
        <dl class="grid grid-cols-2 gap-5 border-t border-ui-border bg-ui-hover/40 p-5 sm:grid-cols-4 sm:p-6">
          <div>
            <dt class="text-xs text-ui-text-muted">{{ t(period === '24h' ? 'aiUsage.hourlyAverage' : 'aiUsage.dailyAverage') }}</dt>
            <dd class="mt-2 text-xl font-medium tabular-nums">{{ metric(stats.average) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-ui-text-muted">{{ t(period === '24h' ? 'aiUsage.peakHour' : 'aiUsage.peakDay') }}</dt>
            <dd class="mt-2 text-xl font-medium tabular-nums">{{ metric(stats.peak?.totalTokens ?? null) }}<span v-if="stats.peak" class="mt-1 block text-xs font-normal text-ui-text-muted">{{ date(stats.peak.start) }}</span></dd>
          </div>
          <div>
            <dt class="text-xs text-ui-text-muted">{{ t(period === '24h' ? 'aiUsage.activeHours' : 'aiUsage.activeDays') }}</dt>
            <dd class="mt-2 text-xl font-medium tabular-nums">{{ reported ? number(stats.active) : "—" }}</dd>
          </div>
          <div>
            <dt class="text-xs text-ui-text-muted">{{ t('aiUsage.longestStreak') }}</dt>
            <dd class="mt-2 text-xl font-medium tabular-nums">{{ reported ? number(stats.longest) : "—" }}<span class="ml-1.5 text-xs font-normal text-ui-text-muted">{{ t(period === '24h' ? 'aiUsage.hours' : 'aiUsage.days') }}</span></dd>
          </div>
        </dl>
      </section>

      <template v-if="reported">
        <AiUsageBreakdown :usage="state" dimension="models" />
        <AiUsageBreakdown :usage="state" dimension="members" />
      </template>
      <p class="text-xs leading-relaxed text-ui-text-muted">{{ t("aiUsage.dataNote", { timeZone }) }}</p>
    </template>
  </div>
</template>
