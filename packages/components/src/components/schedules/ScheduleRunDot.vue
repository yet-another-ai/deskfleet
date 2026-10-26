<script setup lang="ts">
import type { ScheduleRun } from "@deskfleet/client/schedules"

defineProps<{ state: ScheduleRun["state"] }>()
const TONE: Record<ScheduleRun["state"], string> = {
  claimed: "bg-ui-accent",
  running: "bg-ui-accent",
  completed: "bg-ui-success",
  failed: "bg-ui-danger",
  interrupted: "bg-ui-warning",
  skipped: "bg-ui-text-faint",
}
</script>

<template>
  <span class="shrink-0 rounded-full" :class="TONE[state]" aria-hidden="true" />
</template>
