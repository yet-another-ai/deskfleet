<script setup lang="ts">
import { ArrowRightLeft, Bot, Brain, ChevronRight, CircleX, FilePen, FileText, Globe, LoaderCircle, Repeat, Search, SquareTerminal, Trash2, Wrench } from "@lucide/vue"
import { computed, ref, type Component } from "vue"
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui"
import { useI18n } from "vue-i18n"
import type { AgentPermission } from "../../../../../apps/daemon/src/agent-protocol.ts"
import type { ConversationTool } from "../../services/agent-conversation.ts"
import { readableValue } from "../../services/agent-conversation.ts"
import AgentActor from "./AgentActor.vue"
import AgentContent from "./AgentContent.vue"
import AgentTerminal from "./AgentTerminal.vue"
const props = defineProps<{ tool: ConversationTool; permission?: AgentPermission; live?: boolean }>()
const { t } = useI18n()
const open = ref(false)
const icons: Record<string, Component> = { read: FileText, edit: FilePen, delete: Trash2, move: ArrowRightLeft, search: Search, execute: SquareTerminal, think: Brain, fetch: Globe, switch_mode: Repeat }
const icon = computed(() => props.tool.content?.some(block => block.type === "terminal") ? Bot : icons[props.tool.kind ?? ""] ?? Wrench)
// A finished turn leaves no tool running, even when the provider never reported completion.
const running = computed(() => props.live && (props.tool.status === "pending" || props.tool.status === "in_progress"))
const decision = computed(() => props.permission?.state === "resolved" ? props.permission.request.options.find(option => option.optionId === props.permission!.optionId)?.name ?? props.permission.optionId : undefined)
const hasDetails = computed(() => !!props.tool.locations?.length || props.tool.rawInput != null || !!props.tool.content?.length || props.tool.rawOutput != null)
</script>

<template>
  <CollapsibleRoot v-model:open="open" :disabled="!hasDetails" class="text-sm" :data-permission-id="permission?.id">
    <CollapsibleTrigger type="button" class="group/tool -mx-2 flex w-[calc(100%+1rem)] min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-ui-text-muted" :class="hasDetails ? 'cursor-pointer hover:bg-ui-hover hover:text-ui-text' : 'cursor-default'">
      <component :is="icon" :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate">{{ tool.title || t('agent.tool') }}</span>
      <span v-if="permission?.state === 'pending'" class="ui-badge shrink-0 text-ui-warning">{{ t('agent.awaitingApproval') }}</span>
      <span v-else-if="decision" class="shrink-0 text-xs">{{ decision }}<template v-if="permission?.actor?.userId"> · <AgentActor :actor="permission.actor" /></template></span>
      <LoaderCircle v-if="running" :size="14" :stroke-width="2" class="shrink-0 animate-spin" :aria-label="t(`agent.toolStatus.${tool.status}`)" />
      <span v-else-if="tool.status === 'failed'" class="inline-flex shrink-0 items-center gap-1 text-xs text-ui-danger"><CircleX :size="14" :stroke-width="2" aria-hidden="true" />{{ t('agent.toolStatus.failed') }}</span>
      <ChevronRight v-if="hasDetails" :size="14" :stroke-width="2" class="shrink-0 opacity-0 transition-transform group-hover/tool:opacity-100" :class="open && 'rotate-90 opacity-100'" aria-hidden="true" />
    </CollapsibleTrigger>
    <CollapsibleContent class="mt-1 mb-2 ml-6 flex flex-col gap-2 overflow-hidden rounded-lg border border-ui-border bg-ui-surface p-3 text-xs">
      <div v-if="tool.locations?.length" class="font-mono text-ui-text-muted select-text"><div v-for="location in tool.locations" :key="`${location.path}:${location.line}`" class="truncate">{{ location.path }}{{ location.line ? `:${location.line}` : '' }}</div></div>
      <pre v-if="tool.rawInput != null" class="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono select-text">{{ readableValue(tool.rawInput) }}</pre>
      <template v-for="(block, index) in tool.content" :key="index">
        <AgentContent v-if="block.type === 'content'" :content="[block.content]" class="text-xs" />
        <AgentTerminal v-else-if="block.type === 'terminal'" :key="block.terminalId" :terminal-id="block.terminalId" />
        <div v-else-if="block.type === 'diff'" class="overflow-hidden rounded-md border border-ui-border font-mono select-text">
          <div class="truncate border-b border-ui-border px-2 py-1 text-ui-text-muted">{{ block.path }}</div>
          <div class="max-h-80 overflow-auto">
            <pre v-if="block.oldText" class="m-0 whitespace-pre-wrap bg-ui-danger/8 px-2 py-1">{{ block.oldText }}</pre>
            <pre class="m-0 whitespace-pre-wrap bg-ui-success/8 px-2 py-1">{{ block.newText }}</pre>
          </div>
        </div>
        <pre v-else class="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono select-text">{{ readableValue(block) }}</pre>
      </template>
      <pre v-if="tool.rawOutput != null && !tool.content?.length" class="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-ui-border pt-2 font-mono text-ui-text-muted select-text">{{ readableValue(tool.rawOutput) }}</pre>
    </CollapsibleContent>
  </CollapsibleRoot>
</template>
