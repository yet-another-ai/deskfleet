<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import { ClipboardList } from "@lucide/vue"
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentElicitation } from "../../../../../apps/daemon/src/agent-protocol.ts"
import type { CursorPlanApproval } from "../../../../../apps/daemon/src/agents/plans.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import AgentActor from "./AgentActor.vue"
import AgentContent from "./AgentContent.vue"
import AgentPlan from "./AgentPlan.vue"

const props = defineProps<{ elicitation: AgentElicitation; plan: CursorPlanApproval; disabled?: boolean }>()
const { t } = useI18n()
const agents = useAgentSessionsStore()
const pending = computed(() => props.elicitation.state === "pending")
const operation = computed(() => Object.values(agents.operations).find(operation => operation.sessionId === props.elicitation.sessionId && operation.method === "_deskfleet/elicitation/respond" && operation.params.elicitationId === props.elicitation.id))
const disabled = computed(() => props.disabled || !pending.value || !!operation.value)
const failed = ref(false)
const todos = computed(() => {
  if (props.plan.phases?.length) return props.plan.phases.flatMap(phase => phase.todos.map(todo => ({ content: `${phase.name}: ${todo.content}`, status: todo.status })))
  return props.plan.todos.map(todo => ({ content: todo.content, status: todo.status }))
})
const status = computed(() => props.elicitation.state === "cancelled" || props.elicitation.response?.action === "cancel" ? "cancelled" : props.elicitation.response?.action === "decline" ? "rejected" : "accepted")
const planMarkdown = computed(() => [{ type: "text" as const, text: props.plan.plan }])

async function respond(action: "accept" | "decline" | "cancel"): Promise<void> {
  if (disabled.value) return
  failed.value = false
  try { await agents.respondToElicitation(props.elicitation.sessionId, props.elicitation.id, action === "accept" ? { action, content: {} } : { action }) }
  catch { failed.value = true }
}
</script>

<template>
  <section class="rounded-xl border border-ui-warning/40 bg-ui-surface p-4 text-sm shadow-ui-card" data-testid="agent-plan-approval" :data-elicitation-id="elicitation.id" :aria-label="t('agent.planApproval.title')">
    <p class="m-0 mb-2 flex flex-wrap items-center gap-2 font-medium">
      <ClipboardList :size="16" :stroke-width="1.75" class="shrink-0 text-ui-warning" aria-hidden="true" />
      <span>{{ t(pending ? 'agent.planApproval.title' : `agent.planApproval.${status}`) }}<template v-if="!pending && elicitation.actor"> · <AgentActor :actor="elicitation.actor" /></template></span>
      <span v-if="pending" class="ui-badge shrink-0 text-ui-warning">{{ t('agent.awaitingApproval') }}</span>
    </p>
    <p v-if="plan.name" class="m-0 mb-1 font-medium">{{ plan.name }}</p>
    <p v-if="plan.overview" class="m-0 mb-3 whitespace-pre-wrap break-words text-ui-text-muted">{{ plan.overview }}</p>
    <AgentContent :content="planMarkdown" markdown class="mb-3" />
    <AgentPlan v-if="todos.length" :entries="todos" class="mb-3" />
    <div v-if="pending" class="mt-4 flex flex-col gap-2">
      <p v-if="failed || operation?.error" role="alert" class="m-0 text-ui-warning">{{ t('agent.operationPending') }}</p>
      <div class="flex flex-wrap justify-end gap-2">
        <UiButton type="button" data-testid="plan-approval-cancel" :disabled="disabled" @click="respond('cancel')">{{ t('agent.planApproval.cancel') }}</UiButton>
        <UiButton type="button" data-testid="plan-approval-reject" :disabled="disabled" @click="respond('decline')">{{ t('agent.planApproval.reject') }}</UiButton>
        <UiButton variant="primary" type="button" data-testid="plan-approval-accept" :disabled="disabled" @click="respond('accept')">{{ t(operation ? 'agent.planApproval.sending' : 'agent.planApproval.accept') }}</UiButton>
      </div>
    </div>
  </section>
</template>
