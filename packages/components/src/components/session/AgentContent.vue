<script setup lang="ts">
import { ChevronDown, ChevronUp, ExternalLink, FileText } from "@lucide/vue"
import { useId } from "vue"
import { useConversationDisclosures } from "../../stores/conversation-reading.ts"
import { useI18n } from "vue-i18n"
import { isGithubItemUri } from "@deskfleet/protocol/composer-reference"
import type { AgentInput } from "@deskfleet/protocol/agent"
import { previewKindFromUri, type MediaPreviewKind } from "../../services/preview.ts"
import UiScrollArea from "../common/UiScrollArea.vue"
import AgentMarkdown from "./AgentMarkdown.vue"
import AgentResourceLink from "./AgentResourceLink.vue"
import PreviewViewer from "./PreviewViewer.vue"

/** `markdown` renders agent-authored text; user text is shown as typed. */
const props = defineProps<{ content: AgentInput["content"]; disclosureId?: string; markdown?: boolean; final?: boolean }>()
const { t } = useI18n()
const disclosures = useConversationDisclosures()
const localId = useId()
const resourceKey = (index: number) => `pasted:${props.disclosureId ?? localId}:${index}`
const isExpanded = (index: number) => !!disclosures()[resourceKey(index)]

function toggleResource(index: number): void {
  const key = resourceKey(index)
  if (disclosures()[key]) delete disclosures()[key]
  else disclosures()[key] = true
}

function resourceLabel(uri: string, text: string): string {
  if (isGithubItemUri(uri)) return text.split(/\r?\n/u, 1)[0] || uri
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
        <div v-else class="whitespace-pre-wrap" data-reading-surface>{{ block.text }}</div>
      </template>
      <PreviewViewer
        v-else-if="block.type === 'image'"
        :source="{ itemId: `image-${index}` }"
        kind="image"
        :content="`data:${block.mimeType};base64,${block.data}`"
        :mime-type="block.mimeType ?? undefined"
        mode="inline"
      />
      <PreviewViewer
        v-else-if="block.type === 'audio'"
        :source="{ itemId: `audio-${index}` }"
        kind="audio"
        :content="`data:${block.mimeType};base64,${block.data}`"
        :mime-type="block.mimeType ?? undefined"
        mode="inline"
      />
      <div v-else-if="block.type === 'resource' && 'text' in block.resource" class="overflow-hidden rounded-lg border border-ui-border bg-ui-surface/80" data-pasted-resource>
        <div class="flex items-center">
          <button type="button" class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs ui-motion hover:bg-ui-hover" :aria-expanded="isExpanded(index)" @click="toggleResource(index)">
            <FileText :size="14" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate font-medium text-ui-text">{{ resourceLabel(block.resource.uri, block.resource.text) }}</span>
            <span class="shrink-0 text-ui-text-muted">{{ t("agent.pastedTextLines", lineCount(block.resource.text)) }}</span>
            <span class="inline-flex shrink-0 items-center gap-1 text-ui-accent">
              <span>{{ t(isExpanded(index) ? "agent.collapseText" : "agent.expandText") }}</span>
              <component :is="isExpanded(index) ? ChevronUp : ChevronDown" :size="14" aria-hidden="true" />
            </span>
          </button>
          <a v-if="isGithubItemUri(block.resource.uri)" :href="block.resource.uri" target="_blank" rel="noopener noreferrer" :aria-label="block.resource.uri" :title="block.resource.uri" class="mr-1 inline-flex rounded p-1.5 text-ui-accent hover:bg-ui-hover"><ExternalLink :size="14" aria-hidden="true" /></a>
        </div>
        <UiScrollArea v-if="isExpanded(index)" orientation="both" fade-size="sm" class="max-h-80 border-t border-ui-border bg-ui-badge/50">
          <pre class="m-0 p-3 font-mono text-xs whitespace-pre-wrap">{{ block.resource.text }}</pre>
        </UiScrollArea>
        <pre v-else class="m-0 line-clamp-3 overflow-hidden border-t border-ui-border bg-ui-badge/30 px-3 py-2 font-mono text-xs text-ui-text-muted whitespace-pre-wrap">{{ block.resource.text }}</pre>
      </div>
      <PreviewViewer
        v-else-if="block.type === 'resource_link' && resourcePreviewKind(block)"
        :source="{ itemId: `resource-${index}` }"
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
