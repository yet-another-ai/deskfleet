<script setup lang="ts">
import type { TeamAiUsage } from "@deskfleet/client/ai-usage"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import { Info } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { AI_USAGE_COLORS } from "../../services/team-ai-usage.ts"
import AiUsageChart from "./AiUsageChart.vue"

const props = defineProps<{ usage: TeamAiUsage; dimension: "models" | "members" }>()
const { t, locale } = useI18n()
const groups = computed(() => props.usage[props.dimension])
const format = (value: number) => new Intl.NumberFormat(intlLocale(locale.value as AppLocale), { notation: "compact", maximumFractionDigits: 1 }).format(value)
const percent = (value: number) => new Intl.NumberFormat(intlLocale(locale.value as AppLocale), { style: "percent", maximumFractionDigits: 1 }).format(props.usage.totals.totalTokens ? value / props.usage.totals.totalTokens : 0)
const name = (id: string, value: string) => id === "unknown" ? t(props.dimension === "models" ? "aiUsage.unknownModel" : "aiUsage.unknownMember") : value
</script>

<template>
  <section class="ui-card min-w-0 overflow-hidden" :data-ai-usage-breakdown="dimension">
    <div class="flex items-center gap-2 border-b border-ui-border px-5 py-4 sm:px-6">
      <h2 class="text-sm font-medium">{{ t(dimension === "models" ? "aiUsage.byModel" : "aiUsage.byMember") }}</h2>
      <span v-if="dimension === 'models'" tabindex="0" :title="t('aiUsage.modelNote')" :aria-label="t('aiUsage.modelNote')" class="text-ui-text-muted"><Info :size="14" /></span>
    </div>
    <div class="px-3 py-4 sm:px-5">
      <AiUsageChart :buckets="usage.buckets" :groups="groups" :dimension="dimension" :period="usage.period" :time-zone="usage.timeZone" />
    </div>
    <div class="border-t border-ui-border px-5 py-4 sm:px-6">
      <div v-if="usage.totals.totalTokens > 0" class="mb-4 flex h-1.5 overflow-hidden rounded-full bg-ui-hover" aria-hidden="true">
        <span v-for="(group, index) in groups" :key="group.id" :style="{ width: `${group.totalTokens / usage.totals.totalTokens * 100}%`, background: AI_USAGE_COLORS[index % AI_USAGE_COLORS.length] }" />
      </div>
      <ul class="flex flex-wrap gap-x-5 gap-y-3 text-xs">
        <li v-for="(group, index) in groups" :key="group.id" class="flex min-w-0 items-center gap-2">
          <span class="h-2 w-2 shrink-0 rounded-full" :style="{ background: AI_USAGE_COLORS[index % AI_USAGE_COLORS.length] }" />
          <span class="break-all text-ui-text-muted">{{ name(group.id, group.name) }}</span>
          <span class="shrink-0 tabular-nums">{{ group.reportedTurnCount ? format(group.totalTokens) : "—" }}</span>
          <span v-if="group.reportedTurnCount && usage.totals.totalTokens" class="shrink-0 text-ui-text-muted tabular-nums">{{ percent(group.totalTokens) }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>
