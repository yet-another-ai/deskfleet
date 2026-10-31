<script setup lang="ts">
import UiButton from "./UiButton.vue"
import ErrorNotice from "./ErrorNotice.vue"
import { ArrowUp, Check, ChevronRight, File, Folder, Home, Pencil } from "@lucide/vue"
import { DialogTitle } from "reka-ui"
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { FileEntry, FileListing, FilesApi, FileTarget } from "../../../../client/src/files.ts"
import { fileSize } from "../../services/file-format.ts"
import IconButton from "./IconButton.vue"
import UiCheckbox from "./UiCheckbox.vue"
import UiDialog from "./UiDialog.vue"

const props = defineProps<{
  api: FilesApi
  target: FileTarget
  initialPath?: string
  machineName: string
}>()
const emit = defineEmits<{ select: [entries: FileEntry[]]; cancel: [] }>()
const { t } = useI18n()
const pathInputRef = useTemplateRef<HTMLInputElement>("pathInputRef")
const listing = ref<FileListing | null>(null)
const effectiveTarget = computed<FileTarget>(() => props.target.kind === "local" && listing.value?.grantId
  ? { kind: "local", grantId: listing.value.grantId }
  : props.target)
const editingPath = ref(false)
const pathInput = ref(props.initialPath ?? "")
const loading = ref(false)
const error = shallowRef<unknown>()
const showHidden = ref(false)
const trail = ref<{ name: string; path: string }[]>([])
const selectedPaths = ref(new Set<string>())
const visibleEntries = computed(() => listing.value?.entries.filter(entry => showHidden.value || !entry.name.startsWith(".")) ?? [])
const selectedEntries = computed(() => visibleEntries.value.filter(entry => entry.kind === "file" && selectedPaths.value.has(entry.path)))
let requestedPath = props.initialPath
let requestId = 0
let finished = false

function toggleFile(entry: FileEntry): void {
  if (entry.kind !== "file") return
  const next = new Set(selectedPaths.value)
  if (!next.delete(entry.path)) next.add(entry.path)
  selectedPaths.value = next
}

async function navigate(path?: string, name?: string): Promise<boolean> {
  const request = ++requestId
  requestedPath = path
  editingPath.value = false
  if (path !== undefined) pathInput.value = path
  loading.value = true
  error.value = null
  selectedPaths.value = new Set()
  try {
    const next = await props.api.list(effectiveTarget.value, path)
    if (request !== requestId || finished) return false
    const previous = listing.value
    const known = trail.value.findIndex(item => item.path === next.path)
    if (known !== -1) trail.value = trail.value.slice(0, known + 1)
    else if (previous?.path === next.parentPath) trail.value.push({ name: name ?? next.path, path: next.path })
    else trail.value = [{ name: next.path, path: next.path }]
    listing.value = next
    pathInput.value = next.path
    return true
  } catch (reason) {
    if (request === requestId && !finished) error.value = reason
    return false
  } finally {
    if (request === requestId) loading.value = false
  }
}

async function startEditingPath(): Promise<void> {
  if (loading.value || finished) return
  pathInput.value = listing.value?.path ?? requestedPath ?? ""
  editingPath.value = true
  await nextTick()
  pathInputRef.value?.focus()
  pathInputRef.value?.select()
}

function cancelEditingPath(): void {
  editingPath.value = false
  pathInput.value = listing.value?.path ?? requestedPath ?? ""
}

function submitPathInput(): void {
  const trimmed = pathInput.value.trim()
  if (!trimmed || loading.value || finished) return
  if (listing.value?.path === trimmed && !error.value) {
    editingPath.value = false
    return
  }
  void navigate(trimmed)
}

function cancel(): void {
  if (finished) return
  finished = true
  emit("cancel")
}

function select(): void {
  if (loading.value || finished || !selectedEntries.value.length) return
  finished = true
  emit("select", selectedEntries.value)
}

onMounted(() => { void navigate(props.initialPath) })
onBeforeUnmount(() => { finished = true; requestId++ })
</script>

<template>
  <UiDialog class="w-[36rem]" @close="cancel">
    <div class="mb-4 flex items-baseline justify-between gap-3">
      <DialogTitle class="ui-dialog-title">{{ t("filePicker.title") }}</DialogTitle>
      <span class="min-w-0 truncate text-sm text-ui-text-muted" :title="machineName">{{ machineName }}</span>
    </div>
    <nav class="mb-3 flex flex-wrap items-center gap-2" :aria-label="t('folderPicker.locations')">
      <UiButton type="button" :aria-label="t('folderPicker.home')" @click="navigate(listing?.homePath)"><Home :size="14" aria-hidden="true" />{{ t("folderPicker.home") }}</UiButton>
      <UiButton type="button" :disabled="!listing?.parentPath" :aria-label="t('folderPicker.up')" @click="navigate(listing?.parentPath ?? undefined)"><ArrowUp :size="14" aria-hidden="true" />{{ t("folderPicker.up") }}</UiButton>
      <UiButton v-for="root in listing?.roots" :key="root.path" type="button" class="font-mono" :data-path="root.path" @click="navigate(root.path)">{{ root.name }}</UiButton>
    </nav>
    <div v-if="listing || editingPath" class="mb-3 flex items-center gap-1 text-sm" :data-current-path="listing?.path ?? undefined">
      <template v-if="editingPath">
        <input
          ref="pathInputRef"
          v-model="pathInput"
          name="file-picker-path"
          class="ui-input min-w-0 flex-1 font-mono text-xs"
          :aria-label="t('folderPicker.location')"
          autocomplete="off"
          :spellcheck="false"
          @keydown.enter.prevent="submitPathInput"
          @keydown.esc.stop.prevent="cancelEditingPath"
        />
        <IconButton :icon="Check" :label="t('folderPicker.applyPath')" :disabled="loading || !pathInput.trim()" data-apply-path @click="submitPathInput" />
      </template>
      <template v-else-if="listing">
        <nav class="flex min-w-0 flex-1 flex-wrap items-center gap-1" :aria-label="t('folderPicker.location')">
          <template v-for="(item, index) in trail" :key="item.path">
            <ChevronRight v-if="index > 0" :size="12" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
            <button type="button" class="max-w-full cursor-pointer break-all rounded-md px-1.5 py-1 text-left font-mono hover:bg-ui-hover [&[aria-current]]:font-semibold" :aria-current="index === trail.length - 1 ? 'location' : undefined" @click="navigate(item.path)">{{ item.name }}</button>
          </template>
        </nav>
        <IconButton :icon="Pencil" :label="t('folderPicker.editPath')" data-edit-path @click="startEditingPath" />
      </template>
    </div>
    <div class="h-64 overflow-y-auto rounded-xl border border-ui-border bg-ui-canvas" :aria-busy="loading">
      <p v-if="loading" role="status" class="m-0 p-4 text-sm text-ui-text-muted">{{ t("folderPicker.loading") }}</p>
      <ErrorNotice v-else-if="error" :error="error" class="m-4">
        <UiButton type="button" @click="navigate(requestedPath)">{{ t("folderPicker.retry") }}</UiButton>
      </ErrorNotice>
      <ul v-else-if="visibleEntries.length" class="m-0 list-none p-0" :aria-label="t('filePicker.title')">
        <li v-for="entry in visibleEntries" :key="entry.path" class="flex min-w-0 items-center gap-2 px-3 py-2 text-sm hover:bg-ui-hover" :class="selectedPaths.has(entry.path) && 'bg-ui-hover'">
          <UiCheckbox v-if="entry.kind === 'file'" :model-value="selectedPaths.has(entry.path)" :aria-label="t('files.select', { name: entry.name })" @update:model-value="toggleFile(entry)" />
          <span v-else class="w-4 shrink-0" aria-hidden="true" />
          <button
            type="button"
            class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
            :aria-label="entry.kind === 'directory' ? t('folderPicker.openFolder', { name: entry.name }) : t('files.select', { name: entry.name })"
            :data-path="entry.path"
            @click="entry.kind === 'directory' ? navigate(entry.path, entry.name) : toggleFile(entry)"
          >
            <component :is="entry.kind === 'directory' ? Folder : File" :size="16" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate">{{ entry.name }}</span>
            <ChevronRight v-if="entry.kind === 'directory'" :size="14" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
            <span v-else class="shrink-0 text-xs tabular-nums text-ui-text-muted">{{ fileSize(entry.size) }}</span>
          </button>
        </li>
      </ul>
      <p v-else role="status" class="m-0 p-4 text-sm text-ui-text-muted">{{ t("filePicker.empty") }}</p>
    </div>
    <label class="mt-3 flex items-center gap-2 text-sm text-ui-text-muted">
      <UiCheckbox v-model="showHidden" />{{ t("filePicker.showHidden") }}
    </label>
    <div class="ui-dialog-actions">
      <UiButton type="button" @click="cancel">{{ t("catalog.cancel") }}</UiButton>
      <UiButton variant="primary" type="button" :disabled="loading || !!error || !selectedEntries.length" data-confirm-files @click="select">{{ t("filePicker.select") }}</UiButton>
    </div>
  </UiDialog>
</template>
