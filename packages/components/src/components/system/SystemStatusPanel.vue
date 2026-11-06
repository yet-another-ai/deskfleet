<script setup lang="ts">
import { Activity, RefreshCw } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { intlLocale, type AppLocale } from "../../../../client/src/i18n.ts"
import { useSystemStatus } from "../../composables/useSystemStatus.ts"
import { fileSize } from "../../services/file-format.ts"
import UiButton from "../common/UiButton.vue"
import SystemMetricCard from "./SystemMetricCard.vue"
import SystemUsageChart from "./SystemUsageChart.vue"

const props = defineProps<{ machineId: string; machineName: string; online: boolean; active: boolean }>()
const { t, locale } = useI18n()
const { snapshot, history, loading, error, available, running, refresh } = useSystemStatus(() => props.machineId, () => props.active && props.online)
const numberFormat = computed(() => new Intl.NumberFormat(intlLocale(locale.value as AppLocale), { maximumFractionDigits: 1 }))
const memoryPercent = computed(() => snapshot.value?.memoryTotalBytes ? snapshot.value.memoryUsedBytes / snapshot.value.memoryTotalBytes * 100 : 0)
const samples = computed(() => history.value.map(sample => ({
  time: sample.sampledAt,
  cpu: sample.cpuUsagePercent,
  memory: sample.memoryTotalBytes ? sample.memoryUsedBytes / sample.memoryTotalBytes * 100 : 0,
})))
const updated = computed(() => snapshot.value ? new Intl.DateTimeFormat(intlLocale(locale.value as AppLocale), { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(snapshot.value.sampledAt) : "")
const uptime = computed(() => {
  const seconds = snapshot.value?.uptimeSeconds ?? 0
  return t('systemStatus.duration', { days: Math.floor(seconds / 86400), hours: Math.floor(seconds / 3600) % 24, minutes: Math.floor(seconds / 60) % 60 })
})
const memoryDetail = computed(() => snapshot.value ? t('systemStatus.usedOf', { used: fileSize(snapshot.value.memoryUsedBytes), total: fileSize(snapshot.value.memoryTotalBytes) }) : "")
const swapDetail = computed(() => snapshot.value?.swapTotalBytes ? t('systemStatus.total', { total: fileSize(snapshot.value.swapTotalBytes) }) : t('systemStatus.noSwap'))
const swapAmount = computed(() => fileSize(snapshot.value?.swapUsedBytes ?? 0).split(" "))
</script>

<template>
  <div data-system-status class="system-status min-w-0 flex-1 pb-2">
    <div class="mb-4 flex items-center justify-between gap-3 pt-2">
      <h2 class="m-0 min-w-0 truncate text-base font-semibold">{{ machineName }}</h2>
      <div class="flex shrink-0 items-center gap-3">
        <span class="flex items-center gap-1.5 text-xs text-ui-text-muted"><span class="ui-status-dot" :class="online ? 'ui-status-live text-ui-success' : 'text-ui-text-faint'" />{{ t(online ? 'systemStatus.online' : 'systemStatus.offline') }}</span>
        <UiButton variant="ghost" size="icon" data-system-refresh :label="t('systemStatus.refresh')" :disabled="loading || !running" @click="refresh()"><RefreshCw :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
      </div>
    </div>

    <div v-if="error || (snapshot && !online)" class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-ui-warning/10 px-4 py-3 text-xs">
      <span v-if="error" role="alert" class="text-ui-warning">{{ t('systemStatus.failed') }}</span>
      <span v-if="snapshot" data-system-stale class="text-ui-text-muted">{{ t('systemStatus.stale', { time: updated }) }}</span>
    </div>
    <p v-if="!available" role="status" class="py-10 text-center text-sm text-ui-text-muted">{{ t('systemStatus.unavailable') }}</p>
    <div v-else-if="!snapshot && loading" role="status" class="flex min-h-56 items-center justify-center gap-2 text-sm text-ui-text-muted"><Activity :size="18" aria-hidden="true" />{{ t('systemStatus.loading') }}</div>

    <template v-if="snapshot">
      <div class="system-metrics grid grid-cols-1 gap-3">
        <SystemMetricCard metric="cpu" :label="t('systemStatus.cpu')" :value="numberFormat.format(snapshot.cpuUsagePercent)" unit="%" :detail="t('systemStatus.cores', { count: snapshot.logicalCpuCount })" :warning="snapshot.cpuUsagePercent >= 85 ? t('systemStatus.highUsage') : undefined" />
        <SystemMetricCard metric="memory" :label="t('systemStatus.memory')" :value="numberFormat.format(memoryPercent)" unit="%" :detail="memoryDetail" :warning="memoryPercent >= 85 ? t('systemStatus.highUsage') : undefined" />
        <SystemMetricCard metric="swap" :label="t('systemStatus.swap')" :value="swapAmount[0]!" :unit="swapAmount[1]!" :detail="swapDetail" />
      </div>
      <section class="mt-4 overflow-hidden rounded-xl border border-ui-border bg-ui-surface px-4 pb-2 pt-5">
        <h3 class="mb-1 ml-1 mt-0 text-sm font-medium">{{ t('systemStatus.trendTitle') }}</h3>
        <SystemUsageChart :samples="samples" :active="active" />
      </section>
      <dl class="system-info mb-0 mt-5 grid grid-cols-1 gap-x-6 gap-y-4 px-1 text-xs" :aria-label="t('systemStatus.machineInfo')">
        <div><dt class="text-ui-text-muted">{{ t('systemStatus.processor') }}</dt><dd class="m-0 mt-1.5 break-words">{{ snapshot.cpuModel || t('systemStatus.unknown') }}</dd></div>
        <div><dt class="text-ui-text-muted">{{ t('systemStatus.os') }}</dt><dd class="m-0 mt-1.5 break-words">{{ snapshot.os }}</dd></div>
        <div><dt class="text-ui-text-muted">{{ t('systemStatus.arch') }}</dt><dd class="m-0 mt-1.5">{{ snapshot.arch }}</dd></div>
        <div><dt class="text-ui-text-muted">{{ t('systemStatus.uptime') }}</dt><dd class="m-0 mt-1.5 tabular-nums">{{ uptime }}</dd></div>
        <div><dt class="text-ui-text-muted">{{ t('systemStatus.daemonVersion') }}</dt><dd class="m-0 mt-1.5 break-words">{{ snapshot.daemonVersion }}</dd></div>
      </dl>
    </template>
  </div>
</template>

<style scoped>
.system-status { container-type: inline-size; }
@container (min-width: 460px) {
  .system-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .system-info { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@container (min-width: 800px) {
  .system-info { grid-template-columns: repeat(5, minmax(0, 1fr)); }
}
</style>
