<script setup lang="ts">
import { Zap } from "@lucide/vue"
import { computed, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useMachineBatteriesStore } from "../../stores/machine-batteries.ts"

const props = defineProps<{ machineId: string; online: boolean }>()
const { t } = useI18n()
const batteries = useMachineBatteriesStore()
const battery = computed(() => props.online ? batteries.forMachine(props.machineId) : undefined)
const percent = computed(() => Math.max(0, Math.min(100, battery.value?.percent ?? 0)))
const charging = computed(() => battery.value?.state === "charging")
const low = computed(() => battery.value?.state === "discharging" && percent.value <= 15)
const fillWidth = computed(() => 9 * percent.value / 100)
const stateLabel = computed(() => battery.value ? t(`systemStatus.batteryState.${battery.value.state}`) : "")
const label = computed(() => battery.value
  ? t("machine.batteryLabel", { percent: Math.round(percent.value), state: stateLabel.value })
  : "")

watch(() => [props.machineId, props.online] as const, ([machineId, online], _, onCleanup) => {
  if (online) onCleanup(batteries.observe(machineId))
}, { immediate: true })
</script>

<template>
  <span
    v-if="battery"
    class="inline-flex shrink-0 items-center"
    :class="low ? 'text-ui-warning' : 'text-ui-text-muted'"
    role="img"
    :aria-label="label"
    :title="label"
    data-machine-battery
    :data-battery-state="battery.state"
  >
    <svg width="17" height="14" viewBox="0 0 17 14" fill="none" aria-hidden="true">
      <rect x="1" y="2.75" width="12" height="8.5" rx="2" stroke="currentColor" stroke-width="1.4" />
      <rect x="13.75" y="5.5" width="2" height="3" rx="1" fill="currentColor" />
      <rect x="2.5" y="4.25" :width="fillWidth" height="5.5" rx="1.25" fill="currentColor" />
    </svg>
    <Zap v-if="charging" :size="10" :stroke-width="2.5" class="-ml-0.5" aria-hidden="true" />
  </span>
</template>
