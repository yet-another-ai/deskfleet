<script setup lang="ts">
import { watchImmediate } from "@vueuse/core"
import { ref, shallowRef } from "vue"
import { useI18n } from "vue-i18n"
import { parseCsvPreview } from "../../services/csv-preview.ts"
import type { PreviewMode } from "../../services/preview.ts"
import UiScrollArea from "../common/UiScrollArea.vue"

const props = defineProps<{
  src: string
  data?: Uint8Array
  title: string
  mode: PreviewMode
  localActions: boolean
}>()

const { t } = useI18n()
const table = shallowRef<ReturnType<typeof parseCsvPreview>>()
const loading = ref(true)
const failed = ref(false)

watchImmediate([() => props.src, () => props.data], async ([src, data], _previous, onCleanup) => {
  const abort = new AbortController()
  onCleanup(() => abort.abort())
  loading.value = true
  failed.value = false
  table.value = undefined

  try {
    if (data === undefined) {
      const response = await fetch(src, { signal: abort.signal })
      if (!response.ok) throw new Error()
      data = new Uint8Array(await response.arrayBuffer())
    }
    if (!abort.signal.aborted) table.value = parseCsvPreview(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data))
  } catch {
    if (!abort.signal.aborted) failed.value = true
  } finally {
    if (!abort.signal.aborted) loading.value = false
  }
})
</script>

<template>
  <div data-csv-preview class="flex min-h-0 min-w-0 flex-1 flex-col">
    <p v-if="loading" class="m-0 px-3 py-2 text-xs text-ui-text-muted" role="status">{{ t('folderPicker.loading') }}</p>
    <p v-else-if="failed" class="m-0 px-3 py-2 text-xs text-ui-danger" role="alert">
      {{ t(localActions ? 'files.previewUnavailableLocal' : 'files.previewUnavailable') }}
    </p>
    <p v-else-if="!table?.rows.length" class="m-0 px-3 py-2 text-xs text-ui-text-muted">{{ t('files.csvEmpty') }}</p>
    <template v-else>
      <p v-if="table.truncated" class="m-0 shrink-0 px-3 pb-2 text-xs text-ui-text-muted" role="status">
        {{ t('files.csvPreviewLimit', { rows: table.rows.length, columns: table.columnCount }) }}
      </p>
      <UiScrollArea orientation="both" :class="mode === 'inline' ? 'max-h-80' : 'min-h-0 flex-1'">
        <table :aria-label="title" class="csv-table w-max min-w-full border-separate border-spacing-0 text-left text-xs select-text">
          <thead class="sticky top-0 bg-ui-sidebar">
            <tr>
              <th v-for="column in table.columnCount" :key="column" scope="col" class="font-medium">{{ table.rows[0]?.[column - 1] }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in table.rows.slice(1)" :key="index" class="hover:bg-ui-hover">
              <td v-for="column in table.columnCount" :key="column">{{ row[column - 1] }}</td>
            </tr>
          </tbody>
        </table>
      </UiScrollArea>
    </template>
  </div>
</template>

<style scoped>
.csv-table :is(th, td) {
  min-width: 5rem;
  max-width: 20rem;
  padding: 0.375rem 0.75rem;
  vertical-align: top;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border-block-end: 1px solid var(--ui-color-border);
  border-inline-end: 1px solid var(--ui-color-border);
}

.csv-table :is(th, td):last-child { border-inline-end: 0; }
</style>
