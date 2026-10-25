<script setup lang="ts">
import { client } from "@deskfleet/client/platform"
import { Link, LoaderCircle } from "@lucide/vue"
import { computed, inject, ref } from "vue"
import { useI18n } from "vue-i18n"
import { agentResourceContextKey, isFileResource } from "../../services/agent-resources.ts"
const props = defineProps<{ uri: string; name: string }>()
const { t } = useI18n()
const context = inject(agentResourceContextKey, computed(() => undefined))
const pending = ref(false)
const error = ref<string>()
const external = computed(() => /^https?:\/\//iu.test(props.uri))
async function save(): Promise<void> {
  if (pending.value) return
  error.value = undefined
  if (!client.files || !context.value || !isFileResource(props.uri)) { error.value = t("files.resourceUnavailable"); return }
  pending.value = true
  try { await client.files.saveResource({ ...context.value, uri: props.uri }) }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { pending.value = false }
}
</script>

<template>
  <div class="self-start">
    <a v-if="external" :href="uri" class="inline-flex max-w-full items-center gap-1.5 rounded-md bg-ui-badge px-2 py-0.5 text-[13px]" :title="uri"><Link :size="13" aria-hidden="true" /><span class="truncate">{{ name }}</span></a>
    <button v-else type="button" class="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md bg-ui-badge px-2 py-0.5 text-[13px]" :title="uri" :disabled="pending" @click="save"><component :is="pending ? LoaderCircle : Link" :size="13" :class="pending && 'animate-spin'" aria-hidden="true" /><span class="truncate">{{ name }}</span></button>
    <p v-if="error" class="mb-0 mt-1 text-xs text-ui-danger" role="alert">{{ error }}</p>
  </div>
</template>
