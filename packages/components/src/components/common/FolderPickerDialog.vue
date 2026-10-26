<script setup lang="ts">
import { ArrowUp, Check, ChevronRight, Folder, Home, Pencil } from "@lucide/vue"
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { DirectoryListing } from "../../../../client/src/filesystem.ts"
import IconButton from "./IconButton.vue"

const props = defineProps<{
  browse(path?: string): Promise<DirectoryListing>
  initialPath?: string
  machineName: string
}>()
const emit = defineEmits<{ select: [path: string]; cancel: [] }>()
const { t } = useI18n()
const dialog = useTemplateRef<HTMLDialogElement>("dialog")
const pathInputRef = useTemplateRef<HTMLInputElement>("pathInputRef")
const listing = ref<DirectoryListing | null>(null)
const editingPath = ref(false)
const pathInput = ref(props.initialPath ?? "")
const loading = ref(false)
const error = ref<string | null>(null)
const showHidden = ref(false)
const trail = ref<{ name: string; path: string }[]>([])
const visibleDirectories = computed(() => listing.value?.directories.filter(directory => showHidden.value || !directory.hidden) ?? [])
let requestedPath = props.initialPath
let requestId = 0
let finished = false

async function navigate(path?: string, name?: string): Promise<boolean> {
  const request = ++requestId
  requestedPath = path
  editingPath.value = false
  if (path !== undefined) pathInput.value = path
  loading.value = true
  error.value = null
  try {
    const next = await props.browse(path)
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
    if (request === requestId && !finished) error.value = reason instanceof Error ? reason.message : String(reason)
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
  dialog.value?.close()
  emit("cancel")
}
async function select(): Promise<void> {
  if (loading.value || finished) return
  if (editingPath.value) {
    const trimmed = pathInput.value.trim()
    if (!trimmed) return
    if (trimmed !== listing.value?.path || error.value) {
      if (!await navigate(trimmed)) return
    } else {
      editingPath.value = false
    }
  }
  if (!listing.value || loading.value || error.value || finished) return
  finished = true
  dialog.value?.close()
  emit("select", listing.value.path)
}

onMounted(() => {
  dialog.value?.showModal()
  void navigate(props.initialPath)
})
onBeforeUnmount(() => { finished = true; requestId++; dialog.value?.close() })
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="ui-dialog app-no-drag w-[36rem]" aria-labelledby="folder-picker-title" @cancel.prevent.stop="cancel" @close.stop="cancel">
      <div class="mb-4 flex items-baseline justify-between gap-3">
        <h2 id="folder-picker-title" class="ui-dialog-title">{{ t("folderPicker.title") }}</h2>
        <span class="min-w-0 truncate text-sm text-ui-text-muted" :title="machineName">{{ machineName }}</span>
      </div>
      <nav class="mb-3 flex flex-wrap items-center gap-2" :aria-label="t('folderPicker.locations')">
        <button type="button" class="ui-button" :aria-label="t('folderPicker.home')" @click="navigate(listing?.homePath)"><Home :size="14" aria-hidden="true" />{{ t("folderPicker.home") }}</button>
        <button type="button" class="ui-button" :disabled="!listing?.parentPath" :aria-label="t('folderPicker.up')" @click="navigate(listing?.parentPath ?? undefined)"><ArrowUp :size="14" aria-hidden="true" />{{ t("folderPicker.up") }}</button>
        <button v-for="root in listing?.roots" :key="root.path" type="button" class="ui-button font-mono" :data-path="root.path" @click="navigate(root.path)">{{ root.name }}</button>
      </nav>
      <div v-if="listing || editingPath" class="mb-3 flex items-center gap-1 text-sm" :data-current-path="listing?.path ?? undefined">
        <template v-if="editingPath">
          <input
            ref="pathInputRef"
            v-model="pathInput"
            name="folder-picker-path"
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
        <div v-else-if="error" class="flex flex-col items-start gap-3 p-4">
          <p role="alert" class="m-0 break-all text-sm text-ui-danger">{{ error }}</p>
          <button type="button" class="ui-button" @click="navigate(requestedPath)">{{ t("folderPicker.retry") }}</button>
        </div>
        <ul v-else-if="visibleDirectories.length" :aria-label="t('folderPicker.folders')">
          <li v-for="directory in visibleDirectories" :key="directory.path">
            <button type="button" class="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm hover:bg-ui-hover" :aria-label="t('folderPicker.openFolder', { name: directory.name })" :data-path="directory.path" @click="navigate(directory.path, directory.name)">
              <Folder :size="16" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate">{{ directory.name }}</span>
              <ChevronRight :size="14" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
            </button>
          </li>
        </ul>
        <p v-else role="status" class="m-0 p-4 text-sm text-ui-text-muted">{{ t("folderPicker.empty") }}</p>
      </div>
      <label class="mt-3 flex items-center gap-2 text-sm text-ui-text-muted">
        <input v-model="showHidden" type="checkbox" />{{ t("folderPicker.showHidden") }}
      </label>
      <div class="ui-dialog-actions">
        <button type="button" class="ui-button" @click="cancel">{{ t("catalog.cancel") }}</button>
        <button type="button" class="ui-button-primary" :disabled="loading || (editingPath ? !pathInput.trim() : !!error || !listing)" @click="select">{{ t("folderPicker.select") }}</button>
      </div>
    </dialog>
  </Teleport>
</template>
