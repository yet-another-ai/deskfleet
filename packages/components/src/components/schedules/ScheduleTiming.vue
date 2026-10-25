<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { ScheduleInput } from "@deskfleet/client/schedules"

const trigger = defineModel<ScheduleInput["trigger"]>({ required: true })
defineProps<{ disabled?: boolean }>()
const { t, locale } = useI18n()
const rememberedTime = ref("09:00")
const rememberedZone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone)
const kind = computed({
  get: () => trigger.value.kind,
  set: (value: ScheduleInput["trigger"]["kind"]) => {
    const previous = trigger.value
    if (previous.kind === "daily" || previous.kind === "weekly") {
      rememberedTime.value = previous.time
      rememberedZone.value = previous.timeZone
    }
    trigger.value = value === "manual" ? { kind: value }
      : value === "interval" ? { kind: value, minutes: 60 }
        : { kind: value, time: rememberedTime.value, timeZone: rememberedZone.value, ...(value === "weekly" ? { weekdays: [1] } : {}) } as ScheduleInput["trigger"]
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
const weekdays = computed(() => Array.from({ length: 7 }, (_, index) => ({
  value: (index + 1) % 7,
  name: new Intl.DateTimeFormat(locale.value, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 5 + index))),
})))
function toggleDay(day: number): void {
  if (trigger.value.kind !== "weekly") return
  const selected = trigger.value.weekdays
  trigger.value = { ...trigger.value, weekdays: selected.includes(day) ? selected.filter(value => value !== day) : [...selected, day].sort() }
}
</script>

<template>
  <div class="ui-card overflow-hidden">
    <label class="ui-setting flex min-h-14 flex-wrap items-center justify-between gap-3 px-4 py-3">
      <span class="text-ui-text-muted">{{ t('schedules.repeat') }}</span>
      <select v-model="kind" name="schedule-repeat" class="ui-input w-auto" :disabled="disabled">
        <option v-for="option in ['manual', 'daily', 'weekly', 'interval'] as const" :key="option" :value="option">{{ t(`schedules.trigger.${option}`) }}</option>
      </select>
    </label>
    <label v-if="trigger.kind === 'interval'" class="ui-setting flex min-h-14 flex-wrap items-center justify-between gap-3 px-4 py-3">
      <span class="text-ui-text-muted">{{ t('schedules.everyMinutes') }}</span>
      <input v-model.number="trigger.minutes" name="schedule-minutes" type="number" min="1" max="525600" required class="ui-input w-28" :disabled="disabled" />
    </label>
    <template v-if="trigger.kind === 'daily' || trigger.kind === 'weekly'">
      <label class="ui-setting flex min-h-14 flex-wrap items-center justify-between gap-3 px-4 py-3">
        <span class="text-ui-text-muted">{{ t('schedules.at') }}</span>
        <input v-model="time" name="schedule-time" type="time" step="60" required class="ui-input w-auto" :disabled="disabled" />
      </label>
      <label class="ui-setting flex min-h-14 flex-wrap items-center justify-between gap-3 px-4 py-3">
        <span class="text-ui-text-muted">{{ t('schedules.timeZone') }}</span>
        <input v-model="trigger.timeZone" name="schedule-timezone" required class="ui-input w-56 max-w-full" :placeholder="t('schedules.timeZoneHint')" :disabled="disabled" />
      </label>
    </template>
    <div v-if="trigger.kind === 'weekly'" class="ui-setting flex min-h-14 flex-wrap items-center justify-between gap-3 px-4 py-3" role="group" :aria-label="t('schedules.days')">
      <span class="text-ui-text-muted">{{ t('schedules.days') }}</span>
      <div class="flex flex-wrap gap-1">
        <button v-for="day in weekdays" :key="day.value" type="button" class="ui-button px-2" :class="trigger.weekdays.includes(day.value) && 'border-ui-accent bg-ui-accent/10'" :aria-pressed="trigger.weekdays.includes(day.value)" :disabled="disabled" @click="toggleDay(day.value)">{{ day.name }}</button>
      </div>
    </div>
  </div>
</template>
