<script setup lang="ts">
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import AgentResourceViewer from "./AgentResourceViewer.vue"
import type { FileResourceRequest } from "../../../../client/src/files.ts"
import { Link } from "@lucide/vue"
import { computed, inject, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { agentResourceContextKey, isFileResource } from "../../services/agent-resources.ts"

const client = usePlatformClient()
const props = defineProps<{ uri: string; name: string }>()
const { t } = useI18n()
const context = inject(agentResourceContextKey, computed(() => undefined))
const resource = ref<FileResourceRequest>()
const error = ref<string>()
watch(() => JSON.stringify(context.value), () => { resource.value = undefined })
const external = computed(() => /^https?:\/\//iu.test(props.uri))
function open(): void {
  error.value = undefined
  if (!client.files || !context.value || !isFileResource(props.uri)) { error.value = t("files.resourceUnavailable"); return }
  resource.value = { ...context.value, uri: props.uri }
}
</script>

<template>
  <div class="self-start">
    <a v-if="external" :href="uri" class="inline-flex max-w-full items-center gap-1.5 rounded-md bg-ui-badge px-2 py-0.5 text-[13px]" :title="uri"><Link :size="13" aria-hidden="true" /><span class="truncate">{{ name }}</span></a>
    <button v-else type="button" class="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md bg-ui-badge px-2 py-0.5 text-[13px]" :title="uri" @click="open"><Link :size="13" aria-hidden="true" /><span class="truncate">{{ name }}</span></button>
    <AgentResourceViewer v-if="resource && client.files" :api="client.files" :request="resource" @close="resource = undefined" />
    <p v-if="error" class="mb-0 mt-1 text-xs text-ui-danger" role="alert">{{ error }}</p>
  </div>
</template>
