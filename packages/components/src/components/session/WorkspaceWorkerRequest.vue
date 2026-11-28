<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { SuperWorkerRequest } from "@deskfleet/protocol/super-agent"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import ErrorNotice from "../common/ErrorNotice.vue"
import UiButton from "../common/UiButton.vue"
import AgentElicitation from "./AgentElicitation.vue"
import AgentPermissions from "./AgentPermissions.vue"

const props = defineProps<{ request: SuperWorkerRequest; title?: string; disabled: boolean }>()
const emit = defineEmits<{ refresh: [] }>()
const { t } = useI18n()
const agents = useAgentSessionsStore()
const sending = ref(false)
const acknowledged = ref(false)
const error = ref("")
const operation = computed(() => {
  const { kind, item } = props.request
  return Object.values(agents.operations).find(op => op.sessionId === item.sessionId && (kind === "permission"
    ? op.method === "_deskfleet/permission/respond" && op.params.permissionId === item.id
    : op.method === "_deskfleet/elicitation/respond" && op.params.elicitationId === item.id))
})
function answered() {
  acknowledged.value = true
  emit("refresh")
}
async function decide(action: () => Promise<unknown>) {
  if (props.disabled || acknowledged.value || sending.value) return
  sending.value = true
  error.value = ""
  try {
    await action()
    answered()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
    emit("refresh")
  } finally { sending.value = false }
}
function respond(id: string, option: string) {
  const { item } = props.request
  if (!operation.value && id === item.id) void decide(() => agents.respond(item.sessionId, id, option))
}
function checkResult() {
  const current = operation.value
  if (current) void decide(() => agents.checkOperation(current.operationId, { refreshSession: false }))
}
</script>

<template>
  <section v-if="!acknowledged || request.item.state !== 'pending'" :aria-label="title" class="flex min-w-0 flex-col gap-1.5">
    <p v-if="title" class="m-0 break-words text-xs font-medium text-ui-text-muted">{{ title }}</p>
    <AgentPermissions v-if="request.kind === 'permission'" :permissions="[request.item]" :disabled="disabled || sending || !!operation" @respond="respond" />
    <AgentElicitation v-else :elicitation="request.item" :disabled="disabled || sending" @answered="answered" />
    <ErrorNotice v-if="operation?.error || error" :error="operation?.error || error">
      <UiButton v-if="operation?.error" type="button" size="sm" :disabled="disabled || sending" @click="checkResult">{{ t("agent.checkResult") }}</UiButton>
    </ErrorNotice>
  </section>
</template>
