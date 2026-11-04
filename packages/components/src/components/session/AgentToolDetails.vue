<script setup lang="ts">
import type { ConversationTool } from "../../services/agent-conversation.ts"
import { readableValue } from "../../services/agent-conversation.ts"
import AgentContent from "./AgentContent.vue"
import AgentTerminal from "./AgentTerminal.vue"

defineProps<{ tool: ConversationTool; live?: boolean; rawContent?: boolean }>()
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2 text-xs">
    <div v-if="tool.locations?.length" class="font-mono text-ui-text-muted select-text"><div v-for="location in tool.locations" :key="`${location.path}:${location.line}`" class="truncate">{{ location.path }}{{ location.line ? `:${location.line}` : '' }}</div></div>
    <pre v-if="tool.rawInput != null" class="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono select-text">{{ readableValue(tool.rawInput) }}</pre>
    <pre v-if="rawContent && tool.content?.length" class="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono select-text">{{ readableValue(tool.content) }}</pre>
    <template v-for="(block, index) in rawContent ? [] : tool.content" :key="index">
      <AgentContent v-if="block.type === 'content'" :content="[block.content]" class="text-xs" />
      <AgentTerminal v-else-if="block.type === 'terminal'" :key="block.terminalId" :terminal-id="block.terminalId" :output="tool.terminals?.[block.terminalId]" :live="live" />
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
  </div>
</template>
