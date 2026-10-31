<script setup lang="ts">
import { DialogTitle } from "reka-ui"
import { splitLines } from "shiki/core"
import { computed, nextTick, onBeforeUnmount, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { FileEntry, FileResourceRequest, FilesApi } from "../../../../client/src/files.ts"
import { fileResourceLines } from "../../services/agent-resources.ts"
import { fileCodeLanguage, highlighter } from "../../services/code-highlight.ts"
import UiDialog from "../common/UiDialog.vue"
import UiButton from "../common/UiButton.vue"
import FileBrowserPane from "../files/FileBrowserPane.vue"

const props = defineProps<{ api: FilesApi; request: FileResourceRequest }>()
// Vue proxies cannot cross Electron's context bridge, including nested targets.
const request: FileResourceRequest = { ...props.request, target: { ...props.request.target } }
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const entry = ref<FileEntry>()
const content = ref<string>()
const lines = computed(() => content.value === undefined ? [] : splitLines(content.value, true).map(([text]) => ({
  text,
  ending: text.match(/\r?\n$/u)?.[0] ?? "",
})))
const highlightedLines = computed(() => {
  const language = entry.value && fileCodeLanguage(entry.value.name)
  // Preview reads allow 16 MiB; keep large files out of synchronous tokenization.
  if (!language || content.value === undefined || content.value.length > 200_000) return undefined
  try {
    return highlighter.codeToTokens(content.value, {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: "light-dark()",
    }).tokens
  } catch { return undefined }
})
const requestedLines = fileResourceLines(request.uri)
const lineElement = ref<HTMLElement>()
const imageUrl = ref<string>()
const error = ref<string>()
const loading = ref(true)
const downloading = ref(false)
let disposed = false
async function open(): Promise<void> {
  try {
    const result = await props.api.resolveResource(request)
    if (disposed) return
    entry.value = result
    if (result.kind === "file") {
      const file = await props.api.readResource(request)
      if (disposed) return
      if (/^image\/(?:png|jpeg|gif|webp|avif|bmp|vnd\.microsoft\.icon|x-icon)$/u.test(file.mimeType)) {
        imageUrl.value = URL.createObjectURL(new Blob([new Uint8Array(file.data)], { type: file.mimeType }))
      } else {
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(file.data)
          if (text.includes("\0")) throw new Error("Binary file")
          content.value = text
          if (requestedLines) {
            loading.value = false
            await nextTick()
            lineElement.value?.scrollIntoView({ block: "center" })
          }
        } catch { error.value = t("files.previewUnavailable") }
      }
    }
  } catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { if (!disposed) loading.value = false }
}
async function download(): Promise<void> {
  if (downloading.value) return
  downloading.value = true
  try { await props.api.saveResource(request) }
  catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { if (!disposed) downloading.value = false }
}
void open()
onBeforeUnmount(() => { disposed = true; if (imageUrl.value) URL.revokeObjectURL(imageUrl.value) })
</script>

<template>
  <UiDialog class="w-[48rem] max-w-[calc(100vw-2rem)]" @close="emit('close')">
    <DialogTitle class="ui-dialog-title mb-3 break-all">{{ entry?.name ?? request.uri }}</DialogTitle>
    <p v-if="loading" role="status">{{ t('folderPicker.loading') }}</p>
    <FileBrowserPane v-else-if="entry?.kind === 'directory'" :api="api" :target="request.target" :name="entry.name" :initial-path="entry.path" :revision="0" :reset-key="0" :selection="[]" :selectable="false" />
    <img v-else-if="imageUrl" :src="imageUrl" :alt="entry?.name" class="max-h-[60vh] max-w-full object-contain" />
    <pre v-else-if="content !== undefined" class="max-h-[60vh] overflow-auto whitespace-pre text-xs select-text"><code><span
      v-for="(line, index) in lines"
      :key="index"
      :ref="index + 1 === requestedLines?.start ? (element: any) => { lineElement = element } : undefined"
      :class="requestedLines && index + 1 >= requestedLines.start && index + 1 <= requestedLines.end && 'bg-ui-hover'"
    ><template v-if="highlightedLines"><span v-for="(token, tokenIndex) in highlightedLines[index]" :key="tokenIndex" :style="token.htmlStyle">{{ token.content }}</span>{{ line.ending }}</template><template v-else>{{ line.text }}</template></span></code></pre>
    <p v-if="error" class="break-words text-sm text-ui-danger" role="alert">{{ error }}</p>
    <div class="mt-4 flex justify-end gap-2">
      <UiButton v-if="entry" type="button" :disabled="downloading" @click="download">{{ t('files.downloadResource') }}</UiButton>
      <UiButton type="button" @click="emit('close')">{{ t('files.close') }}</UiButton>
    </div>
  </UiDialog>
</template>
