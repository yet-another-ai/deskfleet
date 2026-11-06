<script setup lang="ts">
import { ArrowRightLeft, Bot, Brain, ChevronRight, CircleX, FilePen, FileText, Globe, LoaderCircle, Repeat, Search, SquareTerminal, Trash2, Wrench } from "@lucide/vue"
import { computed, type Component } from "vue"
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui"
import { useI18n } from "vue-i18n"
import type { AgentPermission } from "../../../../../apps/daemon/src/agent-protocol.ts"
import type { ConversationTool } from "../../services/agent-conversation.ts"
import { remoteMcpTool } from "../../services/remote-mcp-tool.ts"
import AgentActor from "./AgentActor.vue"
import AgentRemoteMcpCall from "./AgentRemoteMcpCall.vue"
import AgentToolDetails from "./AgentToolDetails.vue"
import { useConversationDisclosure } from "../../stores/conversation-reading.ts"
const props = defineProps<{ tool: ConversationTool; permission?: AgentPermission; live?: boolean; defaultOpen?: boolean; disclosureId?: string }>()
const { t } = useI18n()
const remote = computed(() => remoteMcpTool(props.tool))
const toggled = useConversationDisclosure(() => `tool:${props.disclosureId ?? props.tool.toolCallId}`)
const icons: Record<string, Component> = { read: FileText, edit: FilePen, delete: Trash2, move: ArrowRightLeft, search: Search, execute: SquareTerminal, think: Brain, fetch: Globe, switch_mode: Repeat }
const icon = computed(() => props.tool.content?.some(block => block.type === "terminal") ? Bot : icons[props.tool.kind ?? ""] ?? Wrench)
// A finished turn leaves no tool running, even when the provider never reported completion.
const running = computed(() => props.live && (props.tool.status === "pending" || props.tool.status === "in_progress"))
const decision = computed(() => props.permission?.state === "resolved" ? props.permission.request.options.find(option => option.optionId === props.permission!.optionId)?.name ?? props.permission.optionId : undefined)
const hasDetails = computed(() => !!props.tool.locations?.length || props.tool.rawInput != null || !!props.tool.content?.length || props.tool.rawOutput != null)
const open = computed(() => hasDetails.value && (toggled.value ?? props.defaultOpen ?? false))
</script>

<template>
  <AgentRemoteMcpCall v-if="remote" :tool="tool" :disclosure-id="disclosureId" :remote="remote" :permission="permission" :live="live" />
  <CollapsibleRoot v-else :open="open" :disabled="!hasDetails" class="text-sm" :data-permission-id="permission?.id" @update:open="toggled = $event">
    <CollapsibleTrigger type="button" class="group/tool -mx-2 flex w-[calc(100%+1rem)] min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-ui-text-muted" :class="hasDetails ? 'cursor-pointer hover:bg-ui-hover hover:text-ui-text' : 'cursor-default'">
      <component :is="icon" :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate">{{ tool.title || t('agent.tool') }}</span>
      <span v-if="permission?.state === 'pending'" class="ui-badge shrink-0 text-ui-warning">{{ t('agent.awaitingApproval') }}</span>
      <span v-else-if="decision" class="shrink-0 text-xs">{{ decision }}<template v-if="permission?.actor?.userId"> · <AgentActor :actor="permission.actor" /></template></span>
      <LoaderCircle v-if="running" :size="14" :stroke-width="2" class="shrink-0 animate-spin" :aria-label="t(`agent.toolStatus.${tool.status}`)" />
      <span v-else-if="tool.status === 'failed'" class="inline-flex shrink-0 items-center gap-1 text-xs text-ui-danger"><CircleX :size="14" :stroke-width="2" aria-hidden="true" />{{ t('agent.toolStatus.failed') }}</span>
      <ChevronRight v-if="hasDetails" :size="14" :stroke-width="2" class="shrink-0 opacity-0 ui-motion group-hover/tool:opacity-100" :class="open && 'rotate-90 opacity-100'" aria-hidden="true" />
    </CollapsibleTrigger>
    <CollapsibleContent class="ui-collapsible">
      <AgentToolDetails :tool="tool" :live="live" class="mt-1 mb-2 ml-6 rounded-lg border border-ui-border bg-ui-surface p-3" />
    </CollapsibleContent>
  </CollapsibleRoot>
</template>
