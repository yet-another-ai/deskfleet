<script setup lang="ts">
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { intlLocale, type AppLocale } from "../../../../client/src/i18n.ts"
import type { AgentUsage } from "../../services/agent-usage.ts"

const props = defineProps<{ usage: AgentUsage }>()
const { t, locale } = useI18n()
const language = computed(() => intlLocale(locale.value as AppLocale))
const numbers = computed(() => new Intl.NumberFormat(language.value))
const ratio = computed(() => props.usage.size > 0 ? props.usage.used / props.usage.size : undefined)
const percent = computed(() => ratio.value === undefined ? "—" : new Intl.NumberFormat(language.value, { style: "percent", maximumFractionDigits: 0 }).format(ratio.value))
const fill = computed(() => Math.min(ratio.value ?? 0, 1) * 100)
const tone = computed(() => ratio.value !== undefined && ratio.value >= 0.9 ? "text-ui-warning" : "text-ui-text-muted")
const summary = computed(() => ratio.value === undefined ? t("agent.usage.title") : t("agent.usage.summary", { percent: percent.value }))
const cost = computed(() => {
  const value = props.usage.cost
  if (!value) return undefined
  const format = { minimumFractionDigits: 2, maximumFractionDigits: 4 }
  // ACP carries the provider's currency string without enforcing ISO syntax.
  if (!/^[a-z]{3}$/i.test(value.currency)) return `${new Intl.NumberFormat(language.value, format).format(value.amount)} ${value.currency}`.trim()
  return new Intl.NumberFormat(language.value, { ...format, style: "currency", currency: value.currency, currencyDisplay: "code" }).format(value.amount)
})
</script>

<template>
  <PopoverRoot>
    <PopoverTrigger type="button" data-agent-usage class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs tabular-nums hover:bg-ui-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-ui-accent" :class="tone" :aria-label="summary" :title="summary">
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="2" opacity="0.2" />
        <circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="2" pathLength="100" :stroke-dasharray="`${fill} 100`" transform="rotate(-90 10 10)" />
      </svg>
      <span>{{ percent }}</span>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent side="top" align="end" :side-offset="8" :collision-padding="8" :aria-label="t('agent.usage.title')" class="ui-menu z-50 w-64 max-w-[calc(100vw-2rem)] p-4">
        <div class="mb-3 flex items-center justify-between gap-4">
          <h3 class="m-0 text-[13px] font-medium">{{ t('agent.usage.context') }}</h3>
          <span class="text-xs tabular-nums" :class="tone">{{ percent }}</span>
        </div>
        <div v-if="ratio !== undefined" role="progressbar" :aria-label="t('agent.usage.context')" :aria-valuemin="0" :aria-valuemax="usage.size" :aria-valuenow="Math.min(usage.used, usage.size)" :aria-valuetext="summary" class="mb-4 h-1.5 overflow-hidden rounded-full bg-ui-hover">
          <div class="h-full rounded-full" :class="ratio >= 0.9 ? 'bg-ui-warning' : 'bg-ui-accent'" :style="{ width: `${fill}%` }" />
        </div>
        <dl class="m-0 flex flex-col gap-2 text-xs">
          <div class="flex items-baseline justify-between gap-4"><dt class="text-ui-text-muted">{{ t('agent.usage.used') }}</dt><dd class="m-0 tabular-nums" data-agent-usage-used>{{ t('agent.usage.tokens', { count: numbers.format(usage.used) }) }}</dd></div>
          <div class="flex items-baseline justify-between gap-4"><dt class="text-ui-text-muted">{{ t('agent.usage.capacity') }}</dt><dd class="m-0 tabular-nums" data-agent-usage-capacity>{{ usage.size > 0 ? t('agent.usage.tokens', { count: numbers.format(usage.size) }) : t('composer.unavailable') }}</dd></div>
          <div v-if="cost !== undefined" class="mt-1 flex items-baseline justify-between gap-4 border-t border-ui-border pt-3"><dt class="text-ui-text-muted">{{ t('agent.usage.cost') }}</dt><dd class="m-0 tabular-nums" data-agent-usage-cost>{{ cost }}</dd></div>
        </dl>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
