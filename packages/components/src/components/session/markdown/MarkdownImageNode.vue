<script setup lang="ts">
import { watchImmediate } from "@vueuse/core"
import { computed, inject, onBeforeUnmount } from "vue"
import { useI18n } from "vue-i18n"
import { isFileResource } from "../../../services/agent-resources.ts"
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
  <img
    v-if="!isLocalResource"
    :src="uri"
    :alt="alt"
    :title="node.title ?? undefined"
  >
  <span v-else-if="state?.url" class="ui-remote-image">
    <img :src="state.url" :alt="alt">
  </span>
  <span v-else-if="state?.error" class="ui-remote-image">
    <button
      type="button"
      class="ui-button"
      :data-resource-retry="uri"
      :title="`${state.error} \u2014 ${t('files.retry')}`"
    >
      {{ alt || t("files.imageUnavailable") }}
    </button>
  </span>
  <span v-else class="ui-remote-image">
    <span class="text-sm text-ui-text-muted">{{ t("files.loadingResource") }}</span>
  </span>
</template>
