<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import UiCheckbox from "../common/UiCheckbox.vue"
import { ArrowUp, File, Folder, FolderOpen, Home, RefreshCw } from "@lucide/vue"
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { FileEntry, FileListing, FileLocation, FilesApi, FileTarget } from "../../../../client/src/files.ts"
import { fileSize } from "../../services/file-format.ts"
import IconButton from "../common/IconButton.vue"
const props = defineProps<{ api: FilesApi; target: FileTarget; name: string; revision: number; resetKey: number; selection: FileEntry[] }>()
const emit = defineEmits<{ selection: [entries: FileEntry[]]; location: [location: FileLocation | undefined] }>()
const { t } = useI18n()
const listing = ref<FileListing>()
const target = computed<FileTarget>(() => props.target.kind === "local" && listing.value?.grantId
  ? { kind: "local", grantId: listing.value.grantId } : props.target)
const selected = computed(() => new Set(props.selection.map(entry => entry.path)))
const hidden = ref(false)
const loading = ref(false)
const error = ref<string>()
const entries = computed(() => listing.value?.entries.filter(entry => hidden.value || !entry.name.startsWith('.')) ?? [])
let requestedPath: string | undefined
let generation = 0
let disposed = false
function clearSelection(): void { emit("selection", []) }
function select(entry: FileEntry): void {
  const next = new Set(selected.value)
  if (!next.delete(entry.path)) next.add(entry.path)
  emit("selection", listing.value?.entries.filter(value => next.has(value.path)) ?? [])
}
async function navigate(path?: string, chosen?: FileListing): Promise<void> {
  const current = ++generation
  requestedPath = path
  loading.value = true; error.value = undefined
  emit("location", undefined); clearSelection()
  try {
    const next = chosen ?? await props.api.list(target.value, path)
    if (disposed || current !== generation) return
    listing.value = next
    emit("location", { target: target.value, path: next.path })
  } catch (reason) {
    if (!disposed && current === generation) error.value = reason instanceof Error ? reason.message : String(reason)
  } finally { if (current === generation) loading.value = false }
}
async function choose(): Promise<void> {
  try {
    const next = await props.api.chooseLocalDirectory()
    if (next && !disposed) await navigate(next.path, next)
  } catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason) }
}
watch(() => props.revision, () => { void navigate(listing.value?.path) })
watch(() => props.resetKey, () => {
  listing.value = undefined
  requestedPath = undefined
  error.value = undefined
  emit("location", undefined)
  clearSelection()
  void navigate()
})
onMounted(() => { void navigate() })
watch(hidden, clearSelection)
onBeforeUnmount(() => { disposed = true; ++generation })
</script>

<template>
  <section class="file-browser-pane flex min-h-64 min-w-0 flex-col overflow-hidden rounded-lg border border-ui-border" :aria-label="name">
    <div class="flex shrink-0 items-center justify-between px-3 py-2"><span class="truncate text-sm font-medium">{{ name }}</span><IconButton v-if="target.kind === 'local'" :icon="FolderOpen" :label="t('files.chooseFolder')" @click="choose" /></div>
    <nav class="flex min-w-0 shrink-0 items-center gap-1 px-2 pb-2" :aria-label="t('folderPicker.location')">
      <IconButton :icon="Home" :label="t('folderPicker.home')" @click="navigate(listing?.homePath)" />
      <IconButton :icon="ArrowUp" :label="t('folderPicker.up')" :disabled="!listing?.parentPath" @click="navigate(listing?.parentPath ?? undefined)" />
      <span v-if="listing" class="min-w-0 flex-1 truncate text-xs" :title="listing.path" :data-current-path="listing.path">{{ listing.path }}</span>
      <IconButton :icon="RefreshCw" :label="t('files.refresh')" :disabled="loading" @click="navigate(requestedPath)" />
    </nav>
    <div class="file-browser-entries max-h-80 min-h-40 flex-1 overflow-y-auto border-t border-ui-border bg-ui-canvas" :aria-busy="loading">
      <p v-if="loading" class="m-0 p-3 text-sm text-ui-text-muted" role="status">{{ t('folderPicker.loading') }}</p>
      <div v-else-if="error" class="flex flex-col items-start gap-2 p-3">
        <p class="m-0 break-all text-xs text-ui-danger" role="alert">{{ error }}</p>
        <UiButton v-if="target.kind === 'local'" type="button" @click="choose">{{ t('files.chooseFolder') }}</UiButton>
        <UiButton v-else type="button" @click="navigate(requestedPath)">{{ t('folderPicker.retry') }}</UiButton>
      </div>
      <ul v-else-if="entries.length" class="m-0 list-none p-0">
        <li v-for="entry in entries" :key="entry.path" class="flex min-w-0 items-center gap-2 px-3 py-2 text-[13px]" :class="selected.has(entry.path) && 'bg-ui-hover'">
          <UiCheckbox :model-value="selected.has(entry.path)" :aria-label="t('files.select', { name: entry.name })" @update:model-value="select(entry)" />
          <button type="button" class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left" :aria-label="entry.kind === 'directory' ? t('folderPicker.openFolder', { name: entry.name }) : t('files.select', { name: entry.name })" @click="entry.kind === 'directory' ? navigate(entry.path) : select(entry)">
            <component :is="entry.kind === 'directory' ? Folder : File" :size="15" class="shrink-0 text-ui-text-muted" aria-hidden="true" /><span class="truncate" :title="entry.name">{{ entry.name }}</span>
          </button>
          <span v-if="entry.kind === 'file'" class="shrink-0 text-[11px] tabular-nums text-ui-text-muted">{{ fileSize(entry.size) }}</span>
        </li>
      </ul>
      <p v-else class="m-0 p-3 text-sm text-ui-text-muted">{{ t('files.empty') }}</p>
    </div>
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-t border-ui-border px-3 py-1.5 text-xs text-ui-text-muted">
      <button v-for="root in listing?.roots" :key="root.path" type="button" class="cursor-pointer rounded px-1 hover:bg-ui-hover" :title="root.path" @click="navigate(root.path)">{{ root.name }}</button>
      <label class="ml-auto flex items-center gap-1.5"><UiCheckbox v-model="hidden" />{{ t('files.showHidden') }}</label>
    </div>
  </section>
</template>

<style scoped>
@container files (min-width: 36rem) {
  .file-browser-pane, .file-browser-entries { min-height: 0; }
  .file-browser-entries { max-height: none; }
}
</style>
