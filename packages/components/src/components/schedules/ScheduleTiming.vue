<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
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
function minuteTime(value: string): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/u.exec(value)
  const hour = match?.[1]
  const minute = match?.[2]
  return hour && minute ? `${hour}:${minute}` : value
}
const time = computed({
  get: () => trigger.value.kind === "daily" || trigger.value.kind === "weekly" ? trigger.value.time : "",
  set: (value: string) => {
    if (trigger.value.kind !== "daily" && trigger.value.kind !== "weekly") return
    // Safari and other browsers can report HH:mm:ss from type="time". Schedules use minute precision.
    trigger.value = { ...trigger.value, time: minuteTime(value) }
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
    <div role="radiogroup" :aria-label="t('schedules.repeat')" class="inline-flex self-start rounded-lg border border-ui-border-strong bg-ui-control p-0.5">
      <label v-for="option in KINDS" :key="option" class="relative cursor-pointer">
        <input v-model="kind" type="radio" name="schedule-repeat" :value="option" class="peer sr-only" :disabled="disabled" />
        <span class="block rounded-md px-3 py-1 text-[13px] font-medium text-ui-text-muted transition-colors hover:text-ui-text peer-checked:bg-ui-active peer-checked:text-ui-text peer-focus-visible:ring-2 peer-focus-visible:ring-ui-accent/40 peer-disabled:op-50">{{ t(`schedules.trigger.${option}`) }}</span>
      </label>
    </div>
    <p v-if="trigger.kind === 'manual'" class="m-0 text-[13px] text-ui-text-muted">{{ t('schedules.manualHint') }}</p>
    <div v-else-if="trigger.kind === 'interval'" class="flex flex-wrap items-center gap-2 text-sm">
      <span id="schedule-interval-label">{{ t('schedules.every') }}</span>
      <input v-model.number="amount" name="schedule-minutes" type="number" min="1" :max="unit === 'hours' ? 8760 : 525600" step="1" required aria-labelledby="schedule-interval-label" class="ui-input w-24" :disabled="disabled" />
      <select v-model="unit" name="schedule-interval-unit" class="ui-input w-auto" :aria-label="t('schedules.intervalUnit')" :disabled="disabled">
        <option value="minutes">{{ t('schedules.unit.minutes', amount) }}</option>
        <option value="hours">{{ t('schedules.unit.hours', amount) }}</option>
      </select>
    </div>
    <template v-else>
      <div v-if="trigger.kind === 'weekly'" role="group" :aria-label="t('schedules.days')" class="flex flex-wrap gap-1.5">
        <label v-for="day in WEEKDAYS" :key="day" class="relative cursor-pointer">
          <input type="checkbox" name="schedule-weekday" :value="day" :checked="trigger.weekdays.includes(day)" class="peer sr-only" :aria-label="weekdayName(day, locale, 'long')" :disabled="disabled" @change="toggleDay(day)" />
          <span class="block min-w-11 rounded-lg border border-ui-border-strong bg-ui-control px-2 py-1 text-center text-[13px] text-ui-text-muted transition-colors hover:text-ui-text peer-checked:border-ui-accent/60 peer-checked:bg-ui-accent/12 peer-checked:text-ui-accent peer-focus-visible:ring-2 peer-focus-visible:ring-ui-accent/40 peer-disabled:op-50">{{ weekdayName(day, locale) }}</span>
        </label>
      </div>
      <div class="flex flex-wrap gap-3">
        <label class="flex flex-col gap-1.5 text-[13px] text-ui-text-muted">
          {{ t('schedules.at') }}
          <input v-model="time" name="schedule-time" type="time" step="60" required class="ui-input w-32 text-sm" :disabled="disabled" />
        </label>
        <label class="flex min-w-0 flex-1 flex-col gap-1.5 text-[13px] text-ui-text-muted">
          {{ t('schedules.timeZone') }}
          <select v-model="trigger.timeZone" name="schedule-timezone" required class="ui-input max-w-72 text-sm" :disabled="disabled">
            <option v-for="zone in zones" :key="zone" :value="zone">{{ zone.replaceAll('_', ' ') }}</option>
          </select>
        </label>
      </div>
    </template>
  </div>
</template>
