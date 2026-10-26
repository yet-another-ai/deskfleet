<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { CheckboxRoot, RadioGroupItem, RadioGroupRoot } from "reka-ui"
import UiSelect from "../common/UiSelect.vue"
import UiTimeField from "../common/UiTimeField.vue"
import UiNumberField from "../common/UiNumberField.vue"
import type { ScheduleInput } from "@deskfleet/client/schedules"
import { WEEKDAYS, localTimeZone, weekdayName } from "./schedule-format.ts"

const trigger = defineModel<ScheduleInput["trigger"]>({ required: true })
defineProps<{ disabled?: boolean }>()
const { t, locale } = useI18n()
const KINDS = ["manual", "daily", "weekly", "interval"] as const
const rememberedTime = ref("09:00")
const rememberedZone = ref(localTimeZone())
// The interval persists minutes; whole hours read better for longer cadences.
const hours = ref(trigger.value.kind === "interval" && trigger.value.minutes % 60 === 0)
const kind = computed({
  get: () => trigger.value.kind,
  set: (value: ScheduleInput["trigger"]["kind"]) => {
    const previous = trigger.value
    if (previous.kind === "daily" || previous.kind === "weekly") {
      rememberedTime.value = previous.time
      rememberedZone.value = previous.timeZone
    }
    hours.value = value === "interval"
    trigger.value = value === "manual" ? { kind: value }
      : value === "interval" ? { kind: value, minutes: 60 }
        : { kind: value, time: rememberedTime.value, timeZone: rememberedZone.value, ...(value === "weekly" ? { weekdays: [1, 2, 3, 4, 5] } : {}) } as ScheduleInput["trigger"]
  },
})
const time = computed({
  get: () => trigger.value.kind === "daily" || trigger.value.kind === "weekly" ? trigger.value.time : "",
  set: (value: string) => {
    if (trigger.value.kind !== "daily" && trigger.value.kind !== "weekly") return
    trigger.value = { ...trigger.value, time: value }
  },
})
// A zone saved elsewhere stays selectable even when this runtime does not list it.
const zones = computed(() => {
  const all = ["UTC", ...Intl.supportedValuesOf("timeZone")]
  const current = "timeZone" in trigger.value ? trigger.value.timeZone : undefined
  return current && !all.includes(current) ? [current, ...all] : all
})
function toggleDay(day: number): void {
  if (trigger.value.kind !== "weekly") return
  const selected = trigger.value.weekdays
  trigger.value = { ...trigger.value, weekdays: selected.includes(day) ? selected.filter(value => value !== day) : [...selected, day].sort() }
}
const amount = computed({
  get: () => trigger.value.kind === "interval" ? trigger.value.minutes / (hours.value ? 60 : 1) : 0,
  set: (value: number) => { if (trigger.value.kind === "interval") trigger.value = { kind: "interval", minutes: Math.round(value * (hours.value ? 60 : 1)) } },
})
const unit = computed({
  get: () => hours.value ? "hours" : "minutes",
  // Changing the unit keeps the number the user typed.
  set: (value: "hours" | "minutes") => { const typed = amount.value; hours.value = value === "hours"; amount.value = typed },
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <RadioGroupRoot :model-value="kind" name="schedule-repeat" :disabled="disabled" orientation="horizontal" :aria-label="t('schedules.repeat')" class="inline-flex self-start rounded-lg border border-ui-border-strong bg-ui-control p-0.5" @update:model-value="kind = $event as typeof kind">
      <RadioGroupItem v-for="option in KINDS" :key="option" :value="option" class="cursor-pointer rounded-md px-3 py-1 text-[13px] font-medium text-ui-text-muted transition-colors hover:text-ui-text data-[state=checked]:bg-ui-active data-[state=checked]:text-ui-text disabled:op-50">{{ t(`schedules.trigger.${option}`) }}</RadioGroupItem>
    </RadioGroupRoot>
    <p v-if="trigger.kind === 'manual'" class="m-0 text-[13px] text-ui-text-muted">{{ t('schedules.manualHint') }}</p>
    <div v-else-if="trigger.kind === 'interval'" class="flex flex-wrap items-center gap-2 text-sm">
      <span id="schedule-interval-label">{{ t('schedules.every') }}</span>
      <UiNumberField v-model="amount" name="schedule-minutes" :min="1" :max="unit === 'hours' ? 8760 : 525600" required aria-labelledby="schedule-interval-label" :disabled="disabled" />
      <UiSelect :model-value="unit" name="schedule-interval-unit" class="w-auto" :options="[{ value: 'minutes', label: t('schedules.unit.minutes', amount) }, { value: 'hours', label: t('schedules.unit.hours', amount) }]" :aria-label="t('schedules.intervalUnit')" :disabled="disabled" @update:model-value="unit = $event as 'hours' | 'minutes'" />
    </div>
    <template v-else>
      <div v-if="trigger.kind === 'weekly'" role="group" :aria-label="t('schedules.days')" class="flex flex-wrap gap-1.5">
        <CheckboxRoot v-for="day in WEEKDAYS" :key="day" name="schedule-weekday" :value="String(day)" :model-value="trigger.weekdays.includes(day)" :aria-label="weekdayName(day, locale, 'long')" :disabled="disabled" class="min-w-11 cursor-pointer rounded-lg border border-ui-border-strong bg-ui-control px-2 py-1 text-center text-[13px] text-ui-text-muted transition-colors hover:text-ui-text data-[state=checked]:border-ui-accent/60 data-[state=checked]:bg-ui-accent/12 data-[state=checked]:text-ui-accent disabled:op-50" @update:model-value="toggleDay(day)">{{ weekdayName(day, locale) }}</CheckboxRoot>
      </div>
      <div class="flex flex-wrap gap-3">
        <label class="flex flex-col gap-1.5 text-[13px] text-ui-text-muted">
          {{ t('schedules.at') }}
          <UiTimeField v-model="time" name="schedule-time" required :locale="locale" :aria-label="t('schedules.at')" :disabled="disabled" />
        </label>
        <label class="flex min-w-0 flex-1 flex-col gap-1.5 text-[13px] text-ui-text-muted">
          {{ t('schedules.timeZone') }}
          <UiSelect v-model="trigger.timeZone" name="schedule-timezone" required searchable class="max-w-72" :options="zones.map(zone => ({ value: zone, label: zone.replaceAll('_', ' ') }))" :aria-label="t('schedules.timeZone')" :disabled="disabled" />
        </label>
      </div>
    </template>
  </div>
</template>
