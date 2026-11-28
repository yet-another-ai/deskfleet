<script setup lang="ts">
import { useI18n } from "vue-i18n"
import type { SessionTarget } from "../../stores/fleet.ts"
import type { AgentUsage as Usage } from "../../services/agent-usage.ts"
import { useSessionGit } from "../../composables/useSessionGit.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import AgentConfigurationSelector from "./AgentConfigurationSelector.vue"
import AgentUsage from "./AgentUsage.vue"
import SessionAutoApprove from "./SessionAutoApprove.vue"

const props = defineProps<{ location: SessionTarget; sessionId: string; active: boolean; disabled: boolean; running: boolean; usage?: Usage | null }>()
const { t } = useI18n()
const layout = useLayoutStore()
const { changes } = useSessionGit(() => props.sessionId, () => props.active && props.location.machine.online && !!props.location.worktree)
</script>

<template>
  <div data-worker-controls role="group" :aria-label="t('superAgent.thisWorker')" class="mx-6 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-ui-border bg-ui-surface px-3 py-1.5">
    <span class="text-xs font-medium text-ui-text-muted">{{ t('superAgent.thisWorker') }}</span>
    <AgentConfigurationSelector :workspace-id="location.workspace?.id" :session-id="sessionId" :disabled="disabled || running" />
    <SessionAutoApprove :machine-id="location.machine.id" :workspace-id="location.workspace?.id" :session-id="sessionId" :disabled="disabled" />
    <div class="ml-auto flex items-center gap-2">
      <button v-if="changes.files" type="button" data-composer-changes :title="t('panel.changes')" :aria-label="t('panel.changes')" class="cursor-pointer rounded-md bg-ui-badge px-1.5 font-mono text-xs hover:bg-ui-hover" @click="layout.requestDetailsOpen()"><span class="text-ui-success">+{{ changes.additions }}</span> <span class="text-ui-danger">−{{ changes.deletions }}</span></button>
      <AgentUsage v-if="usage" :usage="usage" />
    </div>
  </div>
</template>
