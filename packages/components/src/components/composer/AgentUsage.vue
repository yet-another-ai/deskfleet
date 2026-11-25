<script setup lang="ts">
import SpringSurface from "../common/SpringSurface.ts"
import { vSpring } from "../../directives/spring.ts"
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import type { AgentUsage } from "../../services/agent-usage.ts"

const props = defineProps<{ usage: AgentUsage }>()
const { t, locale } = useI18n()
const client = usePlatformClient()
const language = computed(() => intlLocale(locale.value as AppLocale))
const numbers = computed(() => new Intl.NumberFormat(language.value))
const ratio = computed(() => props.usage.size > 0 ? props.usage.used / props.usage.size : undefined)
const percent = computed(() => ratio.value === undefined ? "—" : new Intl.NumberFormat(language.value, { style: "percent", maximumFractionDigits: 0 }).format(ratio.value))
const fill = computed(() => Math.min(ratio.value ?? 0, 1) * 100)
const tone = computed(() => ratio.value !== undefined && ratio.value >= 0.9 ? "text-ui-warning" : "text-ui-text-muted")
const summary = computed(() => ratio.value === undefined ? t("agent.usage.title") : t("agent.usage.summary", { percent: percent.value }))
const cost = computed(() => {
  if (client.mobile) return undefined
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
    <PopoverTrigger
      type="button"
      data-agent-usage
      class="agent-usage-trigger ui-text-button shrink-0 gap-1.5 px-1.5 text-xs tabular-nums"
      :class="ratio !== undefined && ratio >= 0.9 ? 'text-ui-warning hover:text-ui-warning' : undefined"
      :aria-label="summary"
      :title="summary"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" class="shrink-0" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.75" opacity="0.2" />
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.75" pathLength="100" :stroke-dasharray="`${fill} 100`" transform="rotate(-90 12 12)" />
      </svg>
      <span class="agent-usage-percent">{{ percent }}</span>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent :as="SpringSurface" side="top" align="end" :side-offset="8" :collision-padding="8" :aria-label="t('agent.usage.title')" class="ui-card z-50 w-64 max-w-[calc(100vw-2rem)] p-4 shadow-ui-popover">
        <div class="mb-3 flex items-center justify-between gap-4">
          <h3 class="m-0 text-[13px] font-medium">{{ t('agent.usage.context') }}</h3>
          <span class="text-xs tabular-nums" :class="tone">{{ percent }}</span>
        </div>
        <div v-if="ratio !== undefined" role="progressbar" :aria-label="t('agent.usage.context')" :aria-valuemin="0" :aria-valuemax="usage.size" :aria-valuenow="Math.min(usage.used, usage.size)" :aria-valuetext="summary" class="ui-meter mb-4">
          <div class="ui-meter-fill" :class="ratio >= 0.9 ? 'bg-ui-warning' : 'bg-ui-accent'" v-spring.enter="{ width: `${fill}%` }" />
        </div>
        <dl class="m-0 flex flex-col gap-2 text-xs">
          <div class="flex items-baseline justify-between gap-4"><dt class="text-ui-text-muted">{{ t('agent.usage.used') }}</dt><dd class="m-0 tabular-nums" data-agent-usage-used>{{ t('agent.usage.tokens', { count: numbers.format(usage.used) }) }}</dd></div>
          <div class="flex items-baseline justify-between gap-4"><dt class="text-ui-text-muted">{{ t('agent.usage.capacity') }}</dt><dd class="m-0 tabular-nums" data-agent-usage-capacity>{{ usage.size > 0 ? t('agent.usage.tokens', { count: numbers.format(usage.size) }) : t('composer.unavailable') }}</dd></div>
          <div v-if="cost !== undefined" class="-mx-4 mt-1 flex items-baseline justify-between gap-4 border-t border-ui-border-strong px-4 pt-3"><dt class="text-ui-text-muted">{{ t('agent.usage.cost') }}</dt><dd class="m-0 tabular-nums" data-agent-usage-cost>{{ cost }}</dd></div>
        </dl>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style scoped>
@container session-composer (max-width: 32rem) {
  .agent-usage-trigger {
    width: 1.75rem;
    padding-inline: 0;
  }

  .agent-usage-percent {
    display: none;
  }
}
</style>
