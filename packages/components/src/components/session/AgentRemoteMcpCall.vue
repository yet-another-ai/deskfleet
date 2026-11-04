<script setup lang="ts">
import { Check, ChevronRight, CircleX, LoaderCircle, Monitor } from "@lucide/vue"
import { computed, inject, ref } from "vue"
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui"
import { useI18n } from "vue-i18n"
import type { AgentPermission } from "../../../../../apps/daemon/src/agent-protocol.ts"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import type { ConversationTool } from "../../services/agent-conversation.ts"
import { agentResourceContextKey } from "../../services/agent-resources.ts"
import type { RemoteMcpTool } from "../../services/remote-mcp-tool.ts"
import AgentActor from "./AgentActor.vue"
import AgentToolDetails from "./AgentToolDetails.vue"
import PreviewViewer from "./PreviewViewer.vue"

const props = defineProps<{ tool: ConversationTool; remote: RemoteMcpTool; permission?: AgentPermission; live?: boolean }>()
const { t } = useI18n()
const account = useAccountSession()
const context = inject(agentResourceContextKey, undefined)
const machineName = computed(() => {
  const target = context?.value?.target
  const teamId = target?.kind === "machine" ? target.teamId : account?.teamId.value
  return account?.machines.value.find(machine => machine.id === props.remote.machineId && machine.teamId === teamId)?.name || props.remote.machineId
})
const action = computed(() => props.remote.action || props.remote.toolName)
const running = computed(() => props.live && (props.tool.status === "pending" || props.tool.status === "in_progress"))
const failed = computed(() => props.tool.status === "failed" || props.remote.isError)
const decision = computed(() => props.permission?.state === "resolved" ? props.permission.request.options.find(option => option.optionId === props.permission!.optionId)?.name ?? props.permission.optionId : undefined)
const detailsOpen = ref(false)
</script>

<template>
  <article data-remote-mcp-card :data-permission-id="permission?.id" class="my-1 min-w-0 overflow-hidden rounded-xl border border-ui-border bg-ui-surface text-sm">
    <header class="flex min-w-0 items-start gap-3 px-4 py-3">
      <div class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-ui-accent/10 text-ui-accent"><Monitor :size="18" :stroke-width="1.75" aria-hidden="true" /></div>
      <div class="min-w-0 flex-1">
        <div class="break-words font-medium text-ui-text" :title="remote.machineId">{{ machineName }}</div>
        <div class="mt-0.5 break-words text-ui-text-muted">{{ action }}</div>
        <div class="mt-1 break-all text-xs text-ui-text-muted">{{ remote.serverId }} · {{ remote.toolName }}</div>
      </div>
      <div class="flex shrink-0 flex-col items-end gap-1 text-xs">
        <span v-if="permission?.state === 'pending'" class="ui-badge text-ui-warning">{{ t('agent.awaitingApproval') }}</span>
        <span v-else-if="decision" class="text-ui-text-muted">{{ decision }}<template v-if="permission?.actor?.userId"> · <AgentActor :actor="permission.actor" /></template></span>
        <span v-if="failed" class="inline-flex items-center gap-1 text-ui-danger"><CircleX :size="14" aria-hidden="true" />{{ t('agent.toolStatus.failed') }}</span>
        <span v-else-if="running" class="inline-flex items-center gap-1 text-ui-text-muted" role="status"><LoaderCircle :size="14" class="animate-spin" aria-hidden="true" />{{ t(`agent.toolStatus.${tool.status}`) }}</span>
        <span v-else-if="tool.status === 'completed'" class="inline-flex items-center gap-1 text-ui-success"><Check :size="14" aria-hidden="true" />{{ t('agent.toolStatus.completed') }}</span>
      </div>
    </header>
    <div v-if="remote.images.length" class="flex flex-col gap-2 px-3 pb-3">
      <PreviewViewer v-for="(image, index) in remote.images" :key="index" class="remote-mcp-preview" :data-preview="`remote-image-${index}`" kind="image" :content="`data:${image.mimeType};base64,${image.data}`" :mime-type="image.mimeType" :title="t('agent.remoteMcp.screenshot', { machine: machineName, action })" mode="inline" />
    </div>
    <CollapsibleRoot v-model:open="detailsOpen" class="border-t border-ui-border">
      <CollapsibleTrigger type="button" data-remote-mcp-details class="flex w-full cursor-pointer items-center gap-1.5 px-4 py-2 text-left text-xs text-ui-text-muted hover:bg-ui-hover hover:text-ui-text">
        <ChevronRight :size="13" class="shrink-0 ui-motion" :class="detailsOpen && 'rotate-90'" aria-hidden="true" />{{ t('agent.remoteMcp.details') }}
      </CollapsibleTrigger>
      <!-- Remote resource paths must not resolve against the source Agent's machine. -->
      <CollapsibleContent class="ui-collapsible"><AgentToolDetails :tool="tool" :live="live" raw-content class="border-t border-ui-border p-3" /></CollapsibleContent>
    </CollapsibleRoot>
  </article>
</template>

<style scoped>
.remote-mcp-preview :deep([data-preview-canvas]) {
  height: 16rem;
  min-height: 0;
  flex: none;
}
</style>
