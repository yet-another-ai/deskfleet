<script setup lang="ts">
import type { AiUsageDay } from "@deskfleet/client/ai-usage"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import { computed, onMounted, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import { calendarCells, heatmapLevel } from "../../services/team-ai-usage.ts"

const props = defineProps<{ days: AiUsageDay[]; from: string; to: string; selected?: string }>()
const emit = defineEmits<{ select: [date: string] }>()
const { t, locale } = useI18n()
const scroll = useTemplateRef<HTMLDivElement>("scroll")
const cells = computed(() => calendarCells(props.days))
const maximum = computed(() => Math.max(0, ...props.days.map(day => day.totalTokens)))
const weeks = computed(() => Math.ceil(cells.value.length / 7))
const dateFormat = computed(() => new Intl.DateTimeFormat(intlLocale(locale.value as AppLocale), { timeZone: "UTC", dateStyle: "long" }))
const numberFormat = computed(() => new Intl.NumberFormat(intlLocale(locale.value as AppLocale)))
const months = computed(() => {
  const formatter = new Intl.DateTimeFormat(intlLocale(locale.value as AppLocale), { timeZone: "UTC", month: "short" })
  let previous = ""
  const labels = Array.from({ length: weeks.value }, (_, week) => {
    const day = cells.value.slice(week * 7, week * 7 + 7).find(day => day)
    if (!day) return ""
    const month = day.date.slice(0, 7)
    if (month === previous) return ""
    previous = month
    return formatter.format(new Date(`${day.date}T00:00:00Z`))
  })
  // A partial opening month may leave too little room before the next label.
  if (labels.slice(1, 3).some(Boolean)) labels[0] = ""
  return labels
})
function description(day: AiUsageDay): string {
  const date = dateFormat.value.format(new Date(`${day.date}T00:00:00Z`))
  if (day.turnCount === 0) return t("aiUsage.dayEmpty", { date })
  if (day.reportedTurnCount === 0) return t("aiUsage.dayUnreported", { date })
  return t("aiUsage.dayTokens", { date, tokens: numberFormat.value.format(day.totalTokens), reported: day.reportedTurnCount, turns: day.turnCount })
}
onMounted(() => {
  if (scroll.value) scroll.value.scrollLeft = scroll.value.scrollWidth
})
</script>

<template>
  <div class="flex gap-3">
    <div class="grid shrink-0 grid-rows-7 gap-1 pt-7 text-[10px] leading-3 text-ui-text-muted" aria-hidden="true">
      <span>{{ t("aiUsage.monday") }}</span><span /><span>{{ t("aiUsage.wednesday") }}</span><span /><span>{{ t("aiUsage.friday") }}</span><span /><span />
    </div>
    <div ref="scroll" class="min-w-0 flex-1 overflow-x-auto pb-2">
      <div class="heatmap" :style="{ '--weeks': weeks }">
        <div class="months mb-3 h-4 text-[10px] text-ui-text-muted" aria-hidden="true">
          <span v-for="(month, index) in months" :key="index">{{ month }}</span>
        </div>
        <div class="days" :aria-label="t('aiUsage.heatmap')">
          <template v-for="(day, index) in cells" :key="day?.date ?? index">
            <button
              v-if="day" type="button" class="day cursor-pointer rounded-[3px] outline-offset-2 focus-visible:outline-2 focus-visible:outline-ui-accent"
              :class="{ outside: day.date < from || day.date > to, selected: day.date === selected, unreported: day.turnCount > 0 && day.reportedTurnCount === 0 }"
              :data-level="heatmapLevel(day, maximum)" :data-usage-date="day.date" :title="description(day)" :aria-label="description(day)" :aria-pressed="day.date === selected"
              @click="emit('select', day.date)"
            />
            <span v-else />
          </template>
        </div>
      </div>
    </div>
  </div>
  <div class="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-ui-text-muted">
    <span>{{ t("aiUsage.selectDay") }}</span>
    <div class="flex items-center gap-1.5" aria-hidden="true">
      <span class="mr-1">{{ t("aiUsage.less") }}</span>
      <span v-for="level in [0, 1, 2, 3, 4]" :key="level" class="day h-3 w-3 rounded-[3px]" :data-level="level" />
      <span class="ml-1">{{ t("aiUsage.more") }}</span>
    </div>
  </div>
</template>

<style scoped>
.heatmap { min-width: calc(var(--weeks) * 16px); }
.months { display: grid; grid-template-columns: repeat(var(--weeks), minmax(12px, 1fr)); gap: 4px; }
.months span { overflow: visible; white-space: nowrap; }
.days { display: grid; grid-template-rows: repeat(7, 12px); grid-auto-flow: column; grid-template-columns: repeat(var(--weeks), minmax(12px, 1fr)); gap: 4px; }
.day { background: var(--ui-color-hover); }
.day[data-level="1"] { background: color-mix(in srgb, var(--ui-color-accent) 24%, var(--ui-color-surface)); }
.day[data-level="2"] { background: color-mix(in srgb, var(--ui-color-accent) 45%, var(--ui-color-surface)); }
.day[data-level="3"] { background: color-mix(in srgb, var(--ui-color-accent) 70%, var(--ui-color-surface)); }
.day[data-level="4"] { background: var(--ui-color-accent); }
.day.outside { opacity: 0.3; }
.day.unreported { box-shadow: inset 0 0 0 1px var(--ui-color-text-muted); }
.day:hover, .day.selected { opacity: 1; outline: 2px solid var(--ui-color-text-muted); outline-offset: 2px; }
</style>
