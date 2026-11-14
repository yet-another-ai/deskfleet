<script setup lang="ts">
import type { SiteAdministrationApi } from "@deskfleet/client/central"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import type { SiteUsagePeriod } from "@deskfleet/client/site-usage"
import { Building2, MessagesSquare, RadioTower, RefreshCw, Users } from "@lucide/vue"
import { useAsyncState } from "@vueuse/core"
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { fileSize } from "../../services/file-format.ts"
import UiButton from "../common/UiButton.vue"
import SiteUsageChart from "./SiteUsageChart.vue"

const props = defineProps<{ api: Pick<SiteAdministrationApi, "usageTrends"> }>()
const { t, locale } = useI18n()
const period = ref<SiteUsagePeriod>("30d")
const periods: SiteUsagePeriod[] = ["7d", "30d", "90d"]
const inventories = [
  { metric: "users", icon: Users },
  { metric: "teams", icon: Building2 },
  { metric: "sessions", icon: MessagesSquare },
] as const
const { state, error, isLoading, executeImmediate: load } = useAsyncState(
  () => props.api.usageTrends(period.value), undefined, { onError: () => {} },
)
watch(period, () => { void load() })
const number = (value: number) => new Intl.NumberFormat(intlLocale(locale.value as AppLocale)).format(value)
const turns = computed(() => state.value?.buckets.reduce((total, bucket) => total + bucket.turnCount, 0) ?? 0)
// Keep integer byte totals exact until formatting the display value.
const relayedBytes = computed(() => state.value?.buckets.reduce((total, bucket) => total + BigInt(bucket.relayedBytes), 0n) ?? 0n)
const date = (value: string) => new Intl.DateTimeFormat(intlLocale(locale.value as AppLocale), { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(value))
</script>

<template>
  <div class="flex flex-col gap-6" data-site-usage>
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="ui-page-title">{{ t("siteUsage.title") }}</h1>
        <p class="mt-1 text-[13px] text-ui-text-muted">{{ t("siteUsage.description") }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <div class="ui-segmented" role="group" :aria-label="t('siteUsage.period')">
          <button v-for="value in periods" :key="value" type="button" :data-site-usage-period="value" :aria-pressed="period === value" class="ui-segment sm:px-4" :class="period === value && 'ui-segment-active'" @click="period = value">
            {{ t(`siteUsage.periods.${value}`) }}
          </button>
        </div>
        <UiButton variant="ghost" size="icon" :aria-label="t('siteUsage.refresh')" :disabled="isLoading" @click="load()"><RefreshCw :size="15" :class="isLoading && 'animate-spin'" /></UiButton>
      </div>
    </header>

    <div v-if="isLoading" role="status" class="ui-card px-6 py-16 text-center text-sm text-ui-text-muted">{{ t("siteUsage.loading") }}</div>
    <div v-else-if="error" class="ui-card flex items-center justify-between gap-4 p-6">
      <p role="alert" class="text-sm text-ui-danger">{{ t("siteUsage.error") }}</p>
      <UiButton size="sm" @click="load()">{{ t("welcome.retry") }}</UiButton>
    </div>
    <template v-else-if="state">
      <p class="text-xs text-ui-text-muted">{{ date(state.from) }} – {{ date(state.to) }} · UTC</p>
      <div class="grid gap-4 lg:grid-cols-3">
        <section v-for="item in inventories" :key="item.metric" class="ui-card min-w-0 overflow-hidden" :data-site-usage-metric="item.metric">
          <div class="px-5 pb-4 pt-5">
            <h2 class="flex items-center gap-2 text-xs font-medium text-ui-text-muted"><component :is="item.icon" :size="14" aria-hidden="true" />{{ t(`siteUsage.${item.metric}`) }}</h2>
            <p class="mt-3 text-3xl font-medium tracking-tight tabular-nums" data-site-usage-value>{{ number(state.totals[item.metric]) }}</p>
            <p class="mt-2 text-xs text-ui-text-muted">{{ t("siteUsage.currentTotal") }}</p>
          </div>
          <div class="px-3 pb-3"><SiteUsageChart :buckets="state.buckets" :metric="item.metric" :label="t(`siteUsage.${item.metric}`)" compact /></div>
        </section>
      </div>

      <div class="grid gap-4 xl:grid-cols-2">
        <section class="ui-card min-w-0 overflow-hidden" data-site-usage-metric="turnCount">
          <div class="px-5 pb-5 pt-5">
            <h2 class="flex items-center gap-2 text-xs font-medium text-ui-text-muted"><MessagesSquare :size="14" aria-hidden="true" />{{ t("siteUsage.turnCount") }}</h2>
            <p class="mt-3 text-3xl font-medium tracking-tight tabular-nums" data-site-usage-value>{{ number(turns) }}</p>
            <p class="mt-2 text-xs text-ui-text-muted">{{ t("siteUsage.periodTotal") }}</p>
          </div>
          <div class="px-3 pb-3"><SiteUsageChart :buckets="state.buckets" metric="turnCount" :label="t('siteUsage.dailyTurns')" /></div>
        </section>
        <section class="ui-card min-w-0 overflow-hidden" data-site-usage-metric="relayedBytes">
          <div class="px-5 pb-5 pt-5">
            <h2 class="flex items-center gap-2 text-xs font-medium text-ui-text-muted"><RadioTower :size="14" aria-hidden="true" />{{ t("siteUsage.relayedBytes") }}</h2>
            <p class="mt-3 text-3xl font-medium tracking-tight tabular-nums" data-site-usage-value>{{ fileSize(Number(relayedBytes)) }}</p>
            <p class="mt-2 text-xs text-ui-text-muted">{{ t("siteUsage.periodTotal") }}</p>
          </div>
          <div class="px-3 pb-3"><SiteUsageChart :buckets="state.buckets" metric="relayedBytes" :label="t('siteUsage.dailyRelay')" /></div>
        </section>
      </div>
      <div class="space-y-2 text-xs leading-relaxed text-ui-text-muted">
        <p>{{ t("siteUsage.totalsNote") }}</p>
        <p>{{ t("siteUsage.dataNote") }}</p>
        <p v-if="state.relayHistoryIncomplete" data-site-usage-relay-incomplete>{{ t("siteUsage.relayHistoryIncomplete") }}</p>
      </div>
    </template>
  </div>
</template>
