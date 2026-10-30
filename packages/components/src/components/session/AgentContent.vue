<script setup lang="ts">
import { ChevronDown, ChevronUp, FileText } from "@lucide/vue"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentInput } from "../../../../../apps/daemon/src/agent-protocol.ts"
import { previewKindFromUri, type MediaPreviewKind } from "../../services/preview.ts"
import AgentMarkdown from "./AgentMarkdown.vue"
import AgentResourceLink from "./AgentResourceLink.vue"
import PreviewViewer from "./PreviewViewer.vue"

/** `markdown` renders agent-authored text; user text is shown as typed. */
defineProps<{ content: AgentInput["content"]; markdown?: boolean; final?: boolean }>()
const { t } = useI18n()
const expanded = ref(new Set<number>())

function toggleResource(index: number): void {
  const next = new Set(expanded.value)
  if (!next.delete(index)) next.add(index)
  expanded.value = next
}

function resourceLabel(uri: string): string {
  if (!uri || uri.startsWith("deskfleet://pasted-text")) return t("agent.pastedText")
  const name = uri.split(/[\\/]/u).filter(Boolean).at(-1)
  return name ? decodeURIComponent(name) : t("agent.pastedText")
}

function lineCount(text: string): number {
  return text.split(/\r\n|\r|\n/u).length
}

function resourcePreviewKind(block: Extract<AgentInput["content"][number], { type: "resource_link" }>): MediaPreviewKind | undefined {
  return previewKindFromUri(block.name || block.uri, block.mimeType) ?? previewKindFromUri(block.uri, block.mimeType)
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3 break-words select-text">
    <template v-for="(block, index) in content" :key="index">
      <template v-if="block.type === 'text'">
        <AgentMarkdown v-if="markdown" :text="block.text" :final="final" />
        <div v-else class="whitespace-pre-wrap">{{ block.text }}</div>
      </template>
      <PreviewViewer
        v-else-if="block.type === 'image'"
        :data-preview="`image-${index}`"
        kind="image"
        :content="`data:${block.mimeType};base64,${block.data}`"
        :mime-type="block.mimeType ?? undefined"
        mode="inline"
      />
      <PreviewViewer
        v-else-if="block.type === 'audio'"
        :data-preview="`audio-${index}`"
        kind="audio"
        :content="`data:${block.mimeType};base64,${block.data}`"
        :mime-type="block.mimeType ?? undefined"
        mode="inline"
      />
      <div v-else-if="block.type === 'resource' && 'text' in block.resource" class="overflow-hidden rounded-lg border border-ui-border bg-ui-surface/80" data-pasted-resource>
        <button type="button" class="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs hover:bg-ui-hover" :aria-expanded="expanded.has(index)" @click="toggleResource(index)">
          <FileText :size="14" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate font-medium text-ui-text">{{ resourceLabel(block.resource.uri) }}</span>
          <span class="shrink-0 text-ui-text-muted">{{ t("agent.pastedTextLines", lineCount(block.resource.text)) }}</span>
          <span class="inline-flex shrink-0 items-center gap-1 text-ui-accent">
            <span>{{ t(expanded.has(index) ? "agent.collapseText" : "agent.expandText") }}</span>
            <component :is="expanded.has(index) ? ChevronUp : ChevronDown" :size="14" aria-hidden="true" />
          </span>
        </button>
        <pre v-if="expanded.has(index)" class="m-0 max-h-80 overflow-auto border-t border-ui-border bg-ui-badge/50 p-3 font-mono text-xs whitespace-pre-wrap">{{ block.resource.text }}</pre>
        <pre v-else class="m-0 line-clamp-3 overflow-hidden border-t border-ui-border bg-ui-badge/30 px-3 py-2 font-mono text-xs text-ui-text-muted whitespace-pre-wrap">{{ block.resource.text }}</pre>
      </div>
      <PreviewViewer
        v-else-if="block.type === 'resource_link' && resourcePreviewKind(block)"
        :data-preview="`resource-${index}`"
        :kind="resourcePreviewKind(block)"
        :content="block.uri"
        :title="block.name ?? undefined"
        :mime-type="block.mimeType ?? undefined"
        mode="inline"
      />
      <AgentResourceLink v-else-if="block.type === 'resource_link'" :uri="block.uri" :name="block.name" />
      <p v-else class="m-0 text-xs text-ui-text-muted">{{ t('agent.contentType', { type: block.type }) }}</p>
    </template>
  </div>
</template>
