<script setup lang="ts">
import { useI18n } from "vue-i18n"
import type { WorkspaceReplyProgress } from "../../services/workspace-message-timeline.ts"

defineProps<{ progress: WorkspaceReplyProgress }>()
const { t } = useI18n()
</script>

<template>
  <div :data-agent-progress-for="progress.sourceId" role="status" aria-atomic="true"
    class="my-1 border-l-2 border-ui-accent pl-2.5 text-sm leading-relaxed text-ui-text-muted">
    <div v-for="(step, index) in progress.steps" :key="index">
      <template v-if="step.title">{{ step.title }} · </template>{{ t(step.state === "routing" ? "superAgent.state.routing" : `superAgent.progress.${step.state}`) }}
    </div>
  </div>
</template>
