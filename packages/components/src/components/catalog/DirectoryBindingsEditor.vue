<script setup lang="ts">
import { ArrowDown, ArrowUp, Folder, Plus, X } from "@lucide/vue"
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { CatalogDirectory } from "../../../../client/src/catalog.ts"
import type { DirectoryListing } from "../../../../client/src/filesystem.ts"
import FolderPickerDialog from "../common/FolderPickerDialog.vue"

const bindings = defineModel<CatalogDirectory[]>({ required: true })
const props = defineProps<{
  disabled?: boolean
  browse(path?: string): Promise<DirectoryListing>
  machineName: string
}>()
const { t } = useI18n()
const picking = ref<{ index: number; initialPath?: string } | null>(null)
const error = ref<string | null>(null)
watch(() => props.disabled, disabled => { if (disabled) picking.value = null })
function pick(index: number): void {
  if (props.disabled) return
  error.value = null
  picking.value = { index, initialPath: bindings.value[index]?.path || bindings.value[0]?.path || undefined }
}
function add(): void {
  const empty = bindings.value.findIndex(directory => !directory.path)
  pick(empty === -1 ? bindings.value.length : empty)
}
function selected(path: string): void {
  const target = picking.value
  picking.value = null
  if (!target || props.disabled) return
  if (bindings.value.some((directory, index) => directory.path === path && index !== target.index)) {
    error.value = t("catalog.duplicateDirectory")
    return
  }
  const next = [...bindings.value]
  next[target.index] = { path }
  bindings.value = next
}
function move(index: number, offset: number): void {
  const next = index + offset
  if (next < 0 || next >= bindings.value.length) return
  const [directory] = bindings.value.splice(index, 1)
  bindings.value.splice(next, 0, directory!)
}
</script>

<template>
  <fieldset class="m-0 min-w-0 p-0" :disabled="disabled">
    <legend class="mb-1.5 p-0 text-sm">{{ t("worktree.directories") }}</legend>
    <div v-for="(directory, index) in bindings" :key="index" class="mb-2 flex items-center gap-1">
      <button type="button" class="catalog-button min-w-0 flex-1" :name="`directory-path-${index}`" :aria-label="t('catalog.directoryPath', { number: index + 1 })" :title="directory.path || undefined" @click="pick(index)">
        <Folder :size="14" class="shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate text-left" :class="directory.path ? 'font-mono' : 'text-ui-text-muted'">{{ directory.path || t("folderPicker.title") }}</span>
        <span v-if="index === 0" class="ui-badge shrink-0">{{ t("catalog.defaultDirectory") }}</span>
      </button>
      <button type="button" class="catalog-button shrink-0 px-1" :disabled="index === 0" :aria-label="t('catalog.moveDirectoryUp', { number: index + 1 })" @click="move(index, -1)"><ArrowUp :size="13" aria-hidden="true" /></button>
      <button type="button" class="catalog-button shrink-0 px-1" :disabled="index === bindings.length - 1" :aria-label="t('catalog.moveDirectoryDown', { number: index + 1 })" @click="move(index, 1)"><ArrowDown :size="13" aria-hidden="true" /></button>
      <button type="button" class="catalog-button shrink-0 px-1" :disabled="bindings.length === 1" :aria-label="t('catalog.removeDirectory', { number: index + 1 })" @click="bindings.splice(index, 1)"><X :size="13" aria-hidden="true" /></button>
    </div>
    <button type="button" class="catalog-button" @click="add"><Plus :size="14" aria-hidden="true" />{{ t("catalog.addDirectory") }}</button>
    <p v-if="error" role="alert" class="mb-0 mt-2 text-sm text-ui-danger">{{ error }}</p>
  </fieldset>
  <FolderPickerDialog v-if="picking && !disabled" :browse="browse" :machine-name="machineName" :initial-path="picking.initialPath" @select="selected" @cancel="picking = null" />
</template>
