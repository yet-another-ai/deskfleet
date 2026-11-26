<script setup lang="ts">
import { watchImmediate } from "@vueuse/core"
import { computed, inject, onBeforeUnmount } from "vue"
import { useI18n } from "vue-i18n"
import { isFileResource } from "../../../services/agent-resources.ts"
import { previewKindFromMime, previewKindFromUri } from "../../../services/preview.ts"
import PreviewViewer from "../PreviewViewer.vue"
import { markdownHostKey } from "./context.ts"

const props = defineProps<{
  node: { src?: unknown; alt?: unknown; title?: string | null }
}>()

const { t } = useI18n()
const host = inject(markdownHostKey)
let retainedUri: string | undefined

const uri = computed(() => String(props.node.src ?? ""))
const alt = computed(() => String(props.node.alt ?? ""))
const isLocalResource = computed(() => isFileResource(uri.value))
const state = computed(() => (isLocalResource.value ? host?.useImage(uri.value) : undefined))

watchImmediate(uri, newUri => {
  if (retainedUri === newUri) return
  if (retainedUri && isFileResource(retainedUri)) {
    host?.releaseImage(retainedUri)
  }
  retainedUri = newUri
  if (newUri && isFileResource(newUri)) {
    host?.retainImage(newUri)
  }
})

onBeforeUnmount(() => {
  if (retainedUri && isFileResource(retainedUri)) {
    host?.releaseImage(retainedUri)
    retainedUri = undefined
  }
})
</script>

<template>
  <PreviewViewer
    v-if="!isLocalResource"
    :source="{ itemId: uri }"
    :kind="previewKindFromUri(uri) ?? 'image'"
    :content="uri"
    :alt="alt"
    :title="node.title ?? undefined"
    mode="inline"
  />
  <!-- Keep a URI-based locate target throughout loading, retries and blob URL replacement. -->
  <span v-else :data-preview="uri" :data-preview-content="uri" class="ui-remote-image" :class="{ block: state?.url }">
    <PreviewViewer
      v-if="state?.url"
      :source="{ itemId: uri }"
      :locate-anchor="false"
      :kind="previewKindFromMime(state.mimeType) ?? 'image'"
      :content="state.url"
      :data="state.data"
      :can-open="state.canOpen"
      :resource-request="state.request"
      :mime-type="state.mimeType"
      :alt="alt"
      :title="node.title || uri.split(/[\\/]/u).at(-1)"
      mode="inline"
    />
    <button
      v-else-if="state?.error"
      type="button"
      class="ui-button"
      :data-resource-retry="uri"
      :title="`${state.error} \u2014 ${t('files.retry')}`"
    >
      {{ alt || t("files.imageUnavailable") }}
    </button>
    <span v-else class="text-sm text-ui-text-muted">{{ t("files.loadingResource") }}</span>
  </span>
</template>
