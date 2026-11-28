<script setup lang="ts">
import { LoaderCircle, Paperclip } from "@lucide/vue"
import { useElementVisibility } from "@vueuse/core"
import { computed, onScopeDispose, ref, shallowRef, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { isGithubItemUri } from "@deskfleet/protocol/composer-reference"
import type { AgentInput } from "@deskfleet/protocol/agent"
import type { SuperAttachmentInfo, SuperAttachmentPreview } from "@deskfleet/protocol/super-agent"
import AgentContent from "./AgentContent.vue"
import AgentResourceViewer from "./AgentResourceViewer.vue"

const props = defineProps<{ item: SuperAttachmentInfo; messageId: string; index: number; read?: (id: string, index: number) => Promise<SuperAttachmentPreview> }>()
const emit = defineEmits<{ paste: [text: string] }>()
const { t } = useI18n()
const label = computed(() => props.item.type === "image" ? t("agent.image")
  : props.item.type === "resource" && props.item.name === "text/plain" ? t("agent.pastedText") : props.item.name)
const inline = shallowRef<AgentInput["content"]>()
const file = shallowRef<{ name: string; data: Uint8Array; mimeType: string }>()
const loading = ref(false)
const error = ref("")
const root = useTemplateRef<HTMLElement>("root")
const near = useElementVisibility(root, { rootMargin: "160px 0px" })
const canObserve = typeof window.IntersectionObserver === "function"
const isInline = computed(() => props.item.type === "image" || props.item.type === "resource")
const shown = ref(false)
let generation = 0
watch([() => props.read, () => props.messageId, () => props.index], () => {
  ++generation
  inline.value = undefined
  file.value = undefined
  error.value = ""
  loading.value = shown.value = false
}, { flush: "sync" })
onScopeDispose(() => { ++generation })
watch([near, isInline, () => props.read], ([visible, automatic]) => {
  if (visible && automatic && !inline.value && !error.value) void load()
}, { immediate: true })
watch([near, inline], ([visible, content]) => { if (visible && content) shown.value = true })

async function load() {
  if (loading.value || !props.read) return
  const issued = generation
  loading.value = true
  error.value = ""
  try {
    const preview = await props.read(props.messageId, props.index)
    if (issued !== generation) return
    if (!canObserve) shown.value = true
    if (preview.type === "image") inline.value = [preview]
    else if (preview.type === "resource") {
      emit("paste", preview.text)
      const github = preview.uri && isGithubItemUri(preview.uri) ? preview.uri : undefined
      const uri = github ?? (props.item.name === "text/plain" ? "deskfleet://pasted-text/content" : `deskfleet://attachment/${encodeURIComponent(props.item.name)}`)
      inline.value = [{ type: "resource", resource: { uri, text: preview.text, mimeType: github ? preview.mimeType ?? "text/markdown" : "text/plain" } }]
    } else if (preview.type === "resource_link") {
      file.value = { name: props.item.name, mimeType: preview.mimeType, data: Uint8Array.from(atob(preview.data), c => c.charCodeAt(0)) }
    } else error.value = t(preview.type === "tooLarge" ? "superAgent.attachmentPreviewLimit" : "files.resourceUnavailable")
  } catch { if (issued === generation) error.value = t("files.resourceUnavailable") }
  finally { if (issued === generation) loading.value = false }
}
</script>

<template>
  <div ref="root" :data-workspace-attachment="item.type">
    <AgentContent v-if="shown && inline" :content="inline" />
    <button v-else-if="read && (!isInline || error || !canObserve)" type="button" :aria-busy="loading" :disabled="loading" class="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md bg-ui-badge px-2 py-1 text-xs hover:bg-ui-hover" @click="load">
      <LoaderCircle v-if="loading" :size="13" class="shrink-0 animate-spin" aria-hidden="true" /><Paperclip v-else :size="13" aria-hidden="true" />
      <span class="truncate">{{ label }}</span>
    </button>
    <span v-else class="inline-flex min-w-0 items-center gap-1 break-all text-xs text-ui-text-muted" :aria-busy="loading">
      <LoaderCircle v-if="loading" :size="13" class="animate-spin" aria-hidden="true" /><Paperclip v-else :size="13" aria-hidden="true" />{{ label }}
    </span>
    <AgentResourceViewer v-if="file" :file="file" @close="file = undefined" />
    <p v-if="error" role="alert" class="m-0 mt-1 text-xs text-ui-danger">{{ error }}</p>
  </div>
</template>
