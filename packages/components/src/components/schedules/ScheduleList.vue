<script setup lang="ts">
import { CalendarClock, Play } from "@lucide/vue"
import { useIntervalFn, useNow } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import { RouterLink, useRouter } from "vue-router"
import type { ScheduledTask } from "@deskfleet/client/schedules"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useProvidersStore } from "../../stores/providers.ts"
import { absoluteTime, describeTrigger, relativeTime } from "./schedule-format.ts"
import ScheduleRunDot from "./ScheduleRunDot.vue"

defineProps<{ tasks: ScheduledTask[]; disabled?: boolean }>()
const emit = defineEmits<{ run: [task: ScheduledTask]; toggle: [task: ScheduledTask] }>()
const { t, locale } = useI18n()
const providers = useProvidersStore()
const agents = useAgentSessionsStore()
const now = useNow({ scheduler: tick => useIntervalFn(tick, 30_000) })
const router = useRouter()

function destination(task: ScheduledTask): string {
  if (task.target.kind === "existing") return agents.sessions[task.target.sessionId]?.title ?? t("schedules.destination.existing")
  const provider = task.target.provider
  return `${providers.providers.find(value => value.id === provider)?.name ?? provider} · ${t(`schedules.destination.${task.target.context}`)}`
}
function next(task: ScheduledTask): string {
  if (task.trigger.kind === "manual") return t("schedules.onDemand")
  if (!task.enabled) return t("schedules.paused")
  return task.nextRunAt ? t("schedules.nextRelative", { time: relativeTime(task.nextRunAt, now.value, locale.value) }) : t("schedules.notScheduled")
}
</script>

<template>
  <ul class="ui-card m-0 list-none divide-y divide-ui-border p-0">
    <li v-for="task in tasks" :key="task.id" class="flex cursor-pointer items-center gap-4 px-4 py-3.5 transition-colors hover:bg-ui-hover" @click="router.push({ name: 'schedules', params: { scheduleId: task.id } })">
      <CalendarClock :size="18" :stroke-width="1.75" class="shrink-0" :class="task.enabled || task.trigger.kind === 'manual' ? 'text-ui-accent' : 'text-ui-text-faint'" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <RouterLink :to="{ name: 'schedules', params: { scheduleId: task.id } }" :data-schedule-id="task.id" class="block truncate text-sm font-medium text-ui-text no-underline" @click.stop>{{ task.title }}</RouterLink>
        <p class="m-0 mt-0.5 truncate text-[13px] text-ui-text-muted">{{ describeTrigger(task.trigger, t, locale) }} · {{ destination(task) }}</p>
      </div>
      <div class="hidden w-56 shrink-0 text-right text-[13px] md:block">
        <div :title="task.enabled && task.nextRunAt ? absoluteTime(task.nextRunAt, locale) : undefined" :class="task.enabled ? 'text-ui-text' : 'text-ui-text-muted'">{{ next(task) }}</div>
        <div v-if="task.lastRun" class="mt-0.5 flex items-center justify-end gap-1.5 text-ui-text-muted" :title="absoluteTime(task.lastRun.startedAt, locale)">
          <ScheduleRunDot :state="task.lastRun.state" class="h-1.5 w-1.5" />
          <span class="truncate">{{ t(`schedules.runState.${task.lastRun.state}`) }} · {{ relativeTime(task.lastRun.startedAt, now, locale) }}</span>
        </div>
        <div v-else class="mt-0.5 text-ui-text-faint">{{ t('schedules.noRunsShort') }}</div>
      </div>
      <button type="button" data-schedule-run class="ui-button shrink-0 px-2" :aria-label="t('schedules.runNamed', { title: task.title })" :title="t('schedules.run')" :disabled="disabled" @click.stop="emit('run', task)"><Play :size="14" aria-hidden="true" /></button>
      <button v-if="task.trigger.kind !== 'manual'" type="button" role="switch" data-schedule-toggle class="ui-switch" :aria-checked="task.enabled" :aria-label="t('schedules.automaticNamed', { title: task.title })" :disabled="disabled" @click.stop="emit('toggle', task)">
        <span class="ui-switch-thumb" :class="task.enabled && 'translate-x-4'" />
      </button>
      <span v-else class="w-9 shrink-0" aria-hidden="true" />
    </li>
  </ul>
</template>
