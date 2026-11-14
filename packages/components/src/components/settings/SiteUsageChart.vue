<script setup lang="ts">
import type { SiteUsageBucket } from "@deskfleet/client/site-usage"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import { useResizeObserver } from "@vueuse/core"
import { LineChart, type LineSeriesOption } from "echarts/charts"
import { GridComponent, TooltipComponent, type GridComponentOption, type TooltipComponentOption } from "echarts/components"
import { init, use, type ComposeOption, type EChartsType } from "echarts/core"
import { SVGRenderer } from "echarts/renderers"
import { storeToRefs } from "pinia"
import { onBeforeUnmount, onMounted, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { fileSize } from "../../services/file-format.ts"
import { useAppearanceStore } from "../../stores/appearance.ts"

use([LineChart, GridComponent, TooltipComponent, SVGRenderer])
type ChartOption = ComposeOption<LineSeriesOption | GridComponentOption | TooltipComponentOption>
type Metric = "users" | "teams" | "sessions" | "turnCount" | "relayedBytes"
const props = defineProps<{ buckets: SiteUsageBucket[]; metric: Metric; label: string; compact?: boolean }>()
const { locale } = useI18n()
const element = useTemplateRef<HTMLDivElement>("chart")
const { isDark, activeThemeHue, interfaceFont } = storeToRefs(useAppearanceStore())
let chartInstance: EChartsType | undefined
let resizeFrame = 0

function colors(host: HTMLElement): Record<string, string> {
  const probe = document.createElement("span")
  probe.style.visibility = "hidden"
  host.append(probe)
  const palette: Record<string, string> = {}
  for (const token of ["accent", "success", "text", "text-muted", "border", "surface"]) {
    probe.style.color = `var(--ui-color-${token})`
    palette[token] = getComputedStyle(probe).color
  }
  probe.remove()
  return palette
}

function render(): void {
  const host = element.value
  if (!host?.clientWidth || !host.clientHeight) return
  chartInstance ??= init(host, undefined, { renderer: "svg" })
  const palette = colors(host)
  const formatLocale = intlLocale(locale.value as AppLocale)
  const date = new Intl.DateTimeFormat(formatLocale, { timeZone: "UTC", month: "short", day: "numeric" })
  const number = new Intl.NumberFormat(formatLocale)
  const compact = new Intl.NumberFormat(formatLocale, { notation: "compact", maximumFractionDigits: 1 })
  const formatDate = (value: string) => date.format(new Date(`${value}T00:00:00Z`))
  const bytes = props.metric === "relayedBytes"
  const data = props.buckets.map(bucket => Number(bucket[props.metric]))
  const option: ChartOption = {
    animation: false,
    color: [palette[bytes ? "success" : "accent"]!],
    textStyle: { fontFamily: getComputedStyle(host).fontFamily },
    grid: { left: 8, right: 12, top: 12, bottom: 8, outerBoundsMode: "same", outerBoundsContain: "axisLabel" },
    tooltip: {
      trigger: "axis", confine: true, renderMode: "richText",
      backgroundColor: palette.surface, borderColor: palette.border,
      textStyle: { color: palette.text, fontSize: 12 },
      axisPointer: { type: "line", label: { formatter: value => formatDate(String(value.value)) } },
      valueFormatter: value => typeof value === "number" ? (bytes ? fileSize(value) : number.format(value)) : "—",
    },
    xAxis: {
      type: "category", boundaryGap: false, data: props.buckets.map(bucket => bucket.date),
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: palette["text-muted"], fontSize: 10, hideOverlap: true, formatter: formatDate },
    },
    yAxis: {
      type: "value", min: 0, minInterval: 1, splitNumber: props.compact ? 2 : 3,
      axisLabel: { color: palette["text-muted"], fontSize: 10, formatter: value => bytes ? fileSize(value) : compact.format(value) },
      splitLine: { lineStyle: { color: palette.border, type: "dashed" } },
    },
    series: [{
      id: props.metric, name: props.label, type: "line", data,
      showSymbol: data.length === 1, symbolSize: 6,
      lineStyle: { width: 2 }, areaStyle: { opacity: 0.07 }, connectNulls: false,
    }],
  }
  chartInstance.setOption(option, { notMerge: true })
  chartInstance.resize()
}

onMounted(render)
useResizeObserver(element, () => {
  // ECharts writes its SVG dimensions; draw outside the observer delivery cycle.
  cancelAnimationFrame(resizeFrame)
  resizeFrame = requestAnimationFrame(render)
})
watch([() => props.buckets, () => props.metric, () => props.label, () => props.compact, locale, isDark, activeThemeHue, interfaceFont], render, { flush: "post" })
onBeforeUnmount(() => { cancelAnimationFrame(resizeFrame); chartInstance?.dispose() })
</script>

<template>
  <div ref="chart" role="img" :aria-label="label" :data-site-usage-chart="metric" class="min-w-0 w-full" :class="compact ? 'h-40' : 'h-56'" />
</template>
