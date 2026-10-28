<script setup lang="ts">
import type { AiUsageBucket, AiUsageGroup, AiUsagePeriod } from "@deskfleet/client/ai-usage"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import { useResizeObserver } from "@vueuse/core"
import { LineChart, type LineSeriesOption } from "echarts/charts"
import { GridComponent, TooltipComponent, type GridComponentOption, type TooltipComponentOption } from "echarts/components"
import { init, use, type ComposeOption, type EChartsType } from "echarts/core"
import { SVGRenderer } from "echarts/renderers"
import { storeToRefs } from "pinia"
import { onBeforeUnmount, onMounted, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { AI_USAGE_COLORS } from "../../services/team-ai-usage.ts"
import { useAppearanceStore } from "../../stores/appearance.ts"

use([LineChart, GridComponent, TooltipComponent, SVGRenderer])
type ChartOption = ComposeOption<LineSeriesOption | GridComponentOption | TooltipComponentOption>
const props = defineProps<{ buckets: AiUsageBucket[]; groups: AiUsageGroup[]; dimension: "models" | "members"; period: AiUsagePeriod; timeZone: string }>()
const { t, locale } = useI18n()
const element = useTemplateRef<HTMLDivElement>("chart")
const { isDark, interfaceFont } = storeToRefs(useAppearanceStore())
let chartInstance: EChartsType | undefined

function colors(host: HTMLElement): Record<string, string> {
  const probe = document.createElement("span")
  probe.style.visibility = "hidden"
  host.append(probe)
  const result: Record<string, string> = {}
  for (const token of ["text", "text-muted", "border", "surface"]) {
    probe.style.color = `var(--ui-color-${token})`
    result[token] = getComputedStyle(probe).color
  }
  probe.remove()
  return result
}

function render(): void {
  const host = element.value
  if (!host?.clientWidth || !host.clientHeight) return
  chartInstance ??= init(host, undefined, { renderer: "svg" })
  const palette = colors(host)
  const formatLocale = intlLocale(locale.value as AppLocale)
  const date = new Intl.DateTimeFormat(formatLocale, {
    timeZone: props.timeZone, month: "numeric", day: "numeric",
    ...(props.period === "24h" ? { hour: "2-digit", minute: "2-digit", hour12: false } as const : {}),
  })
  const number = new Intl.NumberFormat(formatLocale)
  const compact = new Intl.NumberFormat(formatLocale, { notation: "compact", maximumFractionDigits: 1 })
  const option: ChartOption = {
    animation: false,
    color: AI_USAGE_COLORS,
    textStyle: { fontFamily: getComputedStyle(host).fontFamily },
    grid: { left: 12, right: 16, top: 20, bottom: 12, outerBoundsMode: "same", outerBoundsContain: "axisLabel" },
    tooltip: {
      trigger: "axis", confine: true, renderMode: "richText",
      backgroundColor: palette.surface, borderColor: palette.border,
      textStyle: { color: palette.text, fontSize: 12 },
      axisPointer: { type: "line", label: { formatter: value => date.format(new Date(String(value.value))) } },
      valueFormatter: value => typeof value === "number" ? number.format(value) : "—",
    },
    xAxis: {
      type: "category", boundaryGap: false, data: props.buckets.map(bucket => bucket.start),
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: palette["text-muted"], fontSize: 10, hideOverlap: true, formatter: value => date.format(new Date(value)) },
    },
    yAxis: {
      type: "value", min: 0, minInterval: 1,
      axisLabel: { color: palette["text-muted"], fontSize: 10, formatter: value => compact.format(value) },
      splitLine: { lineStyle: { color: palette.border } },
    },
    series: props.groups.map(group => ({
      id: group.id, name: group.id === "unknown" ? t(props.dimension === "models" ? "aiUsage.unknownModel" : "aiUsage.unknownMember") : group.name,
      type: "line", showSymbol: props.buckets.length === 1, symbolSize: 6,
      data: props.buckets.map(bucket => bucket.turnCount > 0 && bucket.reportedTurnCount === 0 ? null : (bucket[props.dimension][group.id] ?? 0)),
      lineStyle: { width: 2 }, areaStyle: { opacity: 0.07 },
      connectNulls: false, emphasis: { focus: "series" },
    })),
  }
  chartInstance.setOption(option, { notMerge: true })
  chartInstance.resize()
}
onMounted(render)
useResizeObserver(element, render)
watch([() => props.buckets, () => props.groups, () => props.period, () => props.timeZone, locale, isDark, interfaceFont], render, { flush: "post" })
onBeforeUnmount(() => chartInstance?.dispose())
</script>

<template>
  <div ref="chart" role="img" :aria-label="t(dimension === 'models' ? 'aiUsage.modelChart' : 'aiUsage.memberChart')" class="h-60 min-w-0 w-full sm:h-72" />
</template>
