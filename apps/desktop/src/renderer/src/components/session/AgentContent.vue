<script setup lang="ts">
import { Link } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import type { AgentInput } from "../../../../../../daemon/src/agent-protocol.ts"
import AgentMarkdown from "./AgentMarkdown.vue"
/** `markdown` renders agent-authored text; user text is shown as typed. */
defineProps<{ content: AgentInput["content"]; markdown?: boolean }>()
const { t } = useI18n()
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3 break-words select-text">
    <template v-for="(block, index) in content" :key="index">
      <template v-if="block.type === 'text'">
        <AgentMarkdown v-if="markdown" :text="block.text" />
        <div v-else class="whitespace-pre-wrap">{{ block.text }}</div>
      </template>
      <img v-else-if="block.type === 'image'" :src="`data:${block.mimeType};base64,${block.data}`" :alt="t('agent.image')" class="max-h-96 max-w-full self-start rounded-lg object-contain" />
      <pre v-else-if="block.type === 'resource' && 'text' in block.resource" class="m-0 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-ui-badge p-3 font-mono text-xs">{{ block.resource.text }}</pre>
      <span v-else-if="block.type === 'resource_link'" class="inline-flex max-w-full items-center gap-1.5 self-start rounded-md bg-ui-badge px-2 py-0.5 text-[13px]" :title="block.uri"><Link :size="13" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" aria-hidden="true" /><span class="truncate">{{ block.name }}</span></span>
      <p v-else class="m-0 text-xs text-ui-text-muted">{{ t('agent.contentType', { type: block.type }) }}</p>
    </template>
  </div>
</template>
