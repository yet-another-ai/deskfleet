<script setup lang="ts">
import { useResizeObserver } from "@vueuse/core"
import { LineChart, type LineSeriesOption } from "echarts/charts"
import { GridComponent, LegendComponent, TooltipComponent, type GridComponentOption, type LegendComponentOption, type TooltipComponentOption } from "echarts/components"
import { init, use, type ComposeOption, type EChartsType } from "echarts/core"
import { SVGRenderer } from "echarts/renderers"
import { storeToRefs } from "pinia"
import { onBeforeUnmount, onMounted, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { intlLocale, type AppLocale } from "../../../../client/src/i18n.ts"
import { SYSTEM_STATUS_HISTORY, SYSTEM_STATUS_INTERVAL } from "../../composables/useSystemStatus.ts"
import { useAppearanceStore } from "../../stores/appearance.ts"

use([LineChart, GridComponent, LegendComponent, TooltipComponent, SVGRenderer])
type ChartOption = ComposeOption<LineSeriesOption | GridComponentOption | LegendComponentOption | TooltipComponentOption>
const props = defineProps<{ samples: { time: number; cpu: number; memory: number }[]; active: boolean }>()
const { t, locale } = useI18n()
const element = useTemplateRef<HTMLDivElement>("chart")
const { isDark, interfaceFont } = storeToRefs(useAppearanceStore())
let chartInstance: EChartsType | undefined

function colors(host: HTMLElement): Record<string, string> {
  const probe = document.createElement("span")
  probe.style.position = "absolute"
  probe.style.visibility = "hidden"
  host.append(probe)
  const resolved: Record<string, string> = {}
  for (const token of ["accent", "success", "text", "text-muted", "border", "surface"]) {
    probe.style.color = `var(--ui-color-${token})`
    resolved[token] = getComputedStyle(probe).color
  }
  probe.remove()
  return resolved
}

function seriesData(metric: "cpu" | "memory"): [number, number | null][] {
  const data: [number, number | null][] = []
  let previous: number | undefined
  for (const sample of props.samples) {
    if (previous !== undefined && sample.time - previous > SYSTEM_STATUS_INTERVAL * 2.5) {
      data.push([previous + 1, null])
    }
    data.push([sample.time, sample[metric]])
    previous = sample.time
  }
  return data
}

function render(): void {
  const host = element.value
  if (!props.active || !host || !host.clientWidth || !host.clientHeight) return
  chartInstance ??= init(host, undefined, { renderer: "svg" })
  const palette = colors(host)
  const formatLocale = intlLocale(locale.value as AppLocale)
  const time = new Intl.DateTimeFormat(formatLocale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
  const percent = new Intl.NumberFormat(formatLocale, { style: "percent", maximumFractionDigits: 1 })
  const end = props.samples.at(-1)?.time ?? Date.now()
  const option: ChartOption = {
    animation: false,
    color: [palette.accent!, palette.success!],
    textStyle: { fontFamily: getComputedStyle(host).fontFamily },
    grid: { left: 44, right: 16, top: 44, bottom: 28 },
    legend: {
      top: 0, right: 12, icon: "roundRect", itemWidth: 14, itemHeight: 3, itemGap: 24,
      data: [t("systemStatus.cpu"), t("systemStatus.memory")],
      textStyle: { color: palette["text-muted"], fontSize: 12 },
    },
    tooltip: {
      trigger: "axis", confine: true,
      backgroundColor: palette.surface, borderColor: palette.border,
      textStyle: { color: palette.text, fontSize: 12 },
      axisPointer: { type: "line", lineStyle: { color: palette["text-muted"], type: "dashed" }, label: { formatter: value => time.format(Number(value.value)) } },
      valueFormatter: value => {
        const usage = Array.isArray(value) ? value[1] : value
        return typeof usage === "number" ? percent.format(usage / 100) : "—"
      },
    },
    xAxis: {
      type: "time", min: end - SYSTEM_STATUS_HISTORY, max: end,
      splitNumber: host.clientWidth < 480 ? 2 : 4,
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: palette["text-muted"], fontSize: 10, hideOverlap: true, formatter: value => time.format(value) },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value", min: 0, max: 100, interval: 25,
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: palette["text-muted"], fontSize: 10, formatter: "{value}%" },
      splitLine: { lineStyle: { color: palette.border, type: "dashed" } },
    },
    series: (["cpu", "memory"] as const).map(metric => ({
      id: metric, name: t(`systemStatus.${metric}`), type: "line", data: seriesData(metric),
      showSymbol: props.samples.length === 1, symbol: "circle", symbolSize: 6,
      lineStyle: { width: 2 }, areaStyle: { opacity: 0.06 },
      connectNulls: false, emphasis: { focus: "series" },
    })),
  }
  chartInstance.setOption(option)
  chartInstance.resize()
}

onMounted(render)
useResizeObserver(element, render)
watch([() => props.samples, () => props.active, locale, isDark, interfaceFont], render, { flush: "post" })
onBeforeUnmount(() => chartInstance?.dispose())
</script>

<template>
  <div ref="chart" data-system-chart role="img" :aria-label="t('systemStatus.chartLabel')" class="h-72 min-w-0 w-full" />
</template>
