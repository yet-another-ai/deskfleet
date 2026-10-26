<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import { Pause, Play, Trash2 } from "@lucide/vue"
import { useIntervalFn, useNow } from "@vueuse/core"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { RouterLink } from "vue-router"
import type { ScheduleInput, ScheduledTask } from "@deskfleet/client/schedules"
import { absoluteTime, describeTrigger, relativeTime } from "./schedule-format.ts"
import ScheduleEditor from "./ScheduleEditor.vue"
import ScheduleRunDot from "./ScheduleRunDot.vue"

const props = defineProps<{ task: ScheduledTask; disabled?: boolean; save(schedule: ScheduleInput): Promise<ScheduledTask> }>()
const emit = defineEmits<{ run: []; toggle: []; delete: [] }>()
const { t, locale } = useI18n()
const now = useNow({ scheduler: tick => useIntervalFn(tick, 30_000) })
const manual = computed(() => props.task.trigger.kind === "manual")
const zone = computed(() => "timeZone" in props.task.trigger ? props.task.trigger.timeZone : undefined)
const status = computed(() => manual.value ? "onDemand" : props.task.enabled ? "active" : "paused")
const summary = computed(() => {
  const cadence = describeTrigger(props.task.trigger, t, locale.value)
  const next = props.task.nextRunAt
  if (manual.value || !props.task.enabled || !next) return cadence
  return `${cadence} · ${t("schedules.nextAt", { time: absoluteTime(next, locale.value, zone.value), relative: relativeTime(next, now.value, locale.value) })}`
})
</script>

<template>
  <div class="flex flex-col gap-7">
    <header class="flex flex-wrap items-start justify-between gap-4">
      <div class="min-w-0">
        <div class="flex items-center gap-2.5">
          <h1 class="ui-page-title truncate">{{ task.title }}</h1>
          <span class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 text-xs leading-5" :class="status === 'active' ? 'bg-ui-success/12 text-ui-success' : 'bg-ui-badge text-ui-text-muted'">
            <span v-if="status === 'active'" class="h-1.5 w-1.5 rounded-full bg-ui-success" aria-hidden="true" />{{ t(`schedules.status.${status}`) }}
          </span>
        </div>
        <p class="m-0 mt-1.5 text-[13px] text-ui-text-muted">{{ summary }}</p>
      </div>
      <div class="flex shrink-0 gap-2">
        <UiButton type="button" data-schedule-run  :disabled="disabled" @click="emit('run')"><Play :size="14" aria-hidden="true" />{{ t('schedules.run') }}</UiButton>
        <UiButton v-if="!manual" type="button" data-schedule-toggle  :disabled="disabled" @click="emit('toggle')"><component :is="task.enabled ? Pause : Play" :size="14" aria-hidden="true" />{{ t(task.enabled ? 'schedules.pause' : 'schedules.resume') }}</UiButton>
        <UiButton type="button" data-schedule-delete class="px-2" :aria-label="t('schedules.delete')" :title="t('schedules.delete')" :disabled="disabled" @click="emit('delete')"><Trash2 :size="14" aria-hidden="true" /></UiButton>
      </div>
    </header>

    <div class="grid items-start gap-x-10 gap-y-8 xl:grid-cols-[minmax(0,1fr)_17rem]">
      <ScheduleEditor :initial="task" :disabled="disabled" :save="save" />
      <section class="flex flex-col gap-3 xl:sticky xl:top-0" :aria-label="t('schedules.recentRuns')">
        <h2 class="ui-section-title">{{ t('schedules.recentRuns') }}</h2>
        <p v-if="!task.runs.length" class="m-0 text-[13px] leading-5 text-ui-text-muted">{{ t('schedules.noRuns') }}</p>
        <ol v-else class="m-0 flex list-none flex-col p-0">
          <li v-for="(run, index) in task.runs.slice(0, 10)" :key="run.id" class="relative flex gap-3 pb-4">
            <span v-if="index < Math.min(task.runs.length, 10) - 1" class="absolute bottom-0 left-[3.5px] top-4 w-px bg-ui-border" aria-hidden="true" />
            <ScheduleRunDot :state="run.state" class="relative mt-1.5 h-2 w-2" />
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline justify-between gap-2 text-[13px]">
                <span class="font-medium">{{ t(`schedules.runState.${run.state}`) }}</span>
                <RouterLink v-if="run.sessionId" :to="{ name: 'session', params: { sessionId: run.sessionId } }" class="shrink-0 text-xs text-ui-accent no-underline hover:underline">{{ t('schedules.openSession') }}</RouterLink>
              </div>
              <time class="text-xs text-ui-text-muted" :datetime="run.startedAt" :title="absoluteTime(run.startedAt, locale, zone)">{{ relativeTime(run.startedAt, now, locale) }}</time>
              <p v-if="run.error" class="m-0 mt-1 break-words text-xs leading-4.5 text-ui-danger">{{ run.error }}</p>
            </div>
          </li>
        </ol>
      </section>
    </div>
  </div>
</template>
