<script setup lang="ts">
import { RotateCcw, ZoomIn, ZoomOut } from "@lucide/vue"
import type { DocxScrollViewer } from "@silurus/ooxml/docx"
import type { PptxScrollViewer } from "@silurus/ooxml/pptx"
import type { XlsxViewer } from "@silurus/ooxml/xlsx"
import { watchImmediate } from "@vueuse/core"
import { inject, onBeforeUnmount, ref, shallowRef, useTemplateRef, watchEffect } from "vue"
import { useI18n } from "vue-i18n"
import { registerPreviewActionsKey, type OfficePreviewKind, type PreviewMode } from "../../services/preview.ts"
import UiButton from "../common/UiButton.vue"

const props = withDefaults(defineProps<{
  kind: OfficePreviewKind
  src: string
  data?: Uint8Array
  mode?: PreviewMode
}>(), { mode: "inline" })

type OfficeViewer = DocxScrollViewer | PptxScrollViewer | XlsxViewer
const { t } = useI18n()
const registerActions = inject(registerPreviewActionsKey, undefined)
const container = useTemplateRef<HTMLElement>("container")
const viewer = shallowRef<OfficeViewer>()
const loading = ref(true)
const error = ref<string>()
const warning = ref<string>()
const retry = ref(0)

watchEffect(() => {
  const current = viewer.value
  registerActions?.(current && !loading.value && !error.value && props.kind !== "xlsx" ? [
    { id: "zoom-in", icon: ZoomIn, label: t("mermaid.zoomIn"), onClick: () => current.zoomIn() },
    { id: "zoom-out", icon: ZoomOut, label: t("mermaid.zoomOut"), onClick: () => current.zoomOut() },
    { id: "reset", icon: RotateCcw, label: t("mermaid.resetView"), onClick: () => current.fitWidth() },
  ] : [])
})

watchImmediate([container, () => props.kind, () => props.src, () => props.data, retry], async ([host, kind, src, data], _previous, onCleanup) => {
  if (!host) return
  let active = true
  let current: OfficeViewer | undefined
  const abort = new AbortController()
  // A late renderer callback may only touch this attempt's detached surface.
  const surface = document.createElement("div")
  surface.style.cssText = "width:100%;height:100%;overflow:hidden"
  host.replaceChildren(surface)
  loading.value = true
  error.value = undefined
  warning.value = undefined

  function dispose(): void {
    const previous = current
    current = undefined
    if (viewer.value === previous) viewer.value = undefined
    previous?.destroy()
    surface.remove()
  }
  function fail(reason: unknown): void {
    if (!active) return
    active = false
    error.value = reason instanceof Error ? reason.message : t("files.previewUnavailable")
    warning.value = undefined
    loading.value = false
    dispose()
  }
  function reportWarning(reason: unknown): void {
    // Background page/sheet errors do not invalidate already rendered content.
    if (active) warning.value = reason instanceof Error ? reason.message : t("files.previewUnavailable")
  }
  onCleanup(() => { active = false; abort.abort(); dispose() })

  try {
    let buffer: ArrayBuffer
    // DOCX and PPTX may transfer this buffer; retain the original download bytes.
    if (data) buffer = new Uint8Array(data).buffer
    else {
      const response = await fetch(src, { signal: abort.signal })
      if (!response.ok) throw new Error(`${t("files.previewUnavailable")} (${response.status})`)
      buffer = await response.arrayBuffer()
    }
    if (!active) return
    const Viewer = kind === "docx" ? (await import("@silurus/ooxml/docx")).DocxScrollViewer
      : kind === "pptx" ? (await import("@silurus/ooxml/pptx")).PptxScrollViewer
        : (await import("@silurus/ooxml/xlsx")).XlsxViewer
    if (!active) return
    const options = { useGoogleFonts: false, enableHyperlinks: false, enableMediaPlayback: false, onError: reportWarning }
    current = new Viewer(surface, options)
    viewer.value = current
    await current.load(buffer)
    if (active) loading.value = false
  } catch (reason) { fail(reason) }
}, { flush: "post" })

onBeforeUnmount(() => { registerActions?.([]) })
</script>

<template>
  <div
    data-office-preview
    :data-office-kind="kind"
    class="relative min-h-64 w-full flex-1 overflow-hidden bg-white"
    :class="mode === 'inline' ? 'h-96 min-h-96' : 'h-full'"
  >
    <div class="absolute inset-x-0 bottom-0 top-11 flex min-h-0 flex-col">
      <div v-if="warning && !loading && !error" data-office-warning class="flex shrink-0 items-start gap-2 border-b border-ui-border bg-ui-surface px-3 py-2">
        <p class="m-0 min-w-0 flex-1 break-words text-xs text-ui-text-muted" role="alert">{{ warning }}</p>
        <UiButton data-office-retry @click="retry++">{{ t('files.retry') }}</UiButton>
      </div>
      <div ref="container" class="min-h-0 flex-1" />
    </div>
    <div v-if="loading" class="absolute inset-x-0 bottom-0 top-11 flex items-center justify-center bg-ui-surface p-4 text-sm text-ui-text-muted" role="status">
      {{ t('files.loadingResource') }}
    </div>
    <div v-else-if="error" class="absolute inset-x-0 bottom-0 top-11 flex flex-col items-center justify-center gap-3 bg-ui-surface p-4">
      <p class="m-0 max-w-full break-words text-sm text-ui-danger" role="alert">{{ error }}</p>
      <UiButton data-office-retry @click="retry++">{{ t('files.retry') }}</UiButton>
    </div>
  </div>
</template>
