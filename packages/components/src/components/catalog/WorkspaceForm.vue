<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { CatalogDirectory } from "../../../../client/src/catalog.ts"
import type { DirectoryListing } from "../../../../client/src/filesystem.ts"
import DirectoryBindingsEditor from "./DirectoryBindingsEditor.vue"

const props = defineProps<{
  initial?: { name: string; directories: CatalogDirectory[] }
  submitLabel: string
  disabled?: boolean
  browse(path?: string): Promise<DirectoryListing>
  machineName: string
  save(name: string, directories: CatalogDirectory[]): Promise<void>
}>()
const emit = defineEmits<{ cancel: [] }>()
const { t } = useI18n()
const name = ref(props.initial?.name ?? "")
const directories = ref<CatalogDirectory[]>(props.initial?.directories.map(({ path }) => ({ path })) ?? [{ path: "" }])
const saving = ref(false)
const error = ref<string | null>(null)
let suggestedName = ""

function folderName(path: string): string {
  return path.replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() ?? ""
}

watch(() => directories.value[0]?.path, (path) => {
  if (!path) return
  const candidate = folderName(path)
  if (!candidate) return
  if (!name.value.trim() || name.value === suggestedName) {
    name.value = candidate
    suggestedName = candidate
  }
})

async function submit(): Promise<void> {
  if (saving.value || props.disabled) return
  error.value = null
  if (!name.value.trim()) { error.value = t("catalog.nameRequired"); return }
  if (directories.value.length === 0 || directories.value.some(directory => !directory.path)) {
    error.value = t("catalog.directoriesRequired"); return
  }
  saving.value = true
  try { await props.save(name.value.trim(), directories.value.map(({ path }) => ({ path }))) }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { saving.value = false }
}
</script>

<template>
  <form class="flex flex-col gap-4" @submit.prevent="submit">
    <label class="flex flex-col gap-1.5 text-sm">
      {{ t("catalog.workspaceName") }}
      <input v-model="name" name="workspace-name" required class="ui-input" :disabled="saving || disabled" />
    </label>
    <DirectoryBindingsEditor v-model="directories" :browse="browse" :machine-name="machineName" :disabled="saving || disabled" />
    <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
    <div class="mt-2 flex justify-end gap-2">
      <UiButton type="button" :disabled="saving" @click="emit('cancel')">{{ t("catalog.cancel") }}</UiButton>
      <UiButton variant="primary" type="submit" :loading="saving" :disabled="saving || disabled">{{ saving ? t("catalog.saving") : submitLabel }}</UiButton>
    </div>
  </form>
</template>
