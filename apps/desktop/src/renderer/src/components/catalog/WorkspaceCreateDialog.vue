<script setup lang="ts">
import { onMounted, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { CatalogDirectory } from "../../../../shared/catalog.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import WorkspaceForm from "./WorkspaceForm.vue"

const emit = defineEmits<{ created: [id: string]; cancel: [] }>()
const { t } = useI18n()
const fleet = useFleetStore()
const browseDirectories = (path?: string) => window.deskfleet.filesystem.listDirectories(path)
const dialog = useTemplateRef<HTMLDialogElement>("dialog")
let created = false

onMounted(() => dialog.value?.showModal())

async function create(name: string, directories: CatalogDirectory[]): Promise<void> {
  const { id } = await fleet.createWorkspace(name, directories)
  created = true
  emit("created", id)
}

// Escape closes the dialog without creating anything.
function closed(): void {
  if (!created) emit("cancel")
}
</script>

<template>
  <dialog ref="dialog" class="ui-dialog app-no-drag w-[28rem]" aria-labelledby="workspace-create-title" @close="closed">
    <h2 id="workspace-create-title" class="m-0 mb-4 text-base font-semibold">{{ t("catalog.newWorkspace") }}</h2>
    <WorkspaceForm :submit-label="t('catalog.create')" :disabled="!fleet.canManageCatalog" :browse="browseDirectories" :machine-name="fleet.localDesktopTarget.name" :save="create" @cancel="dialog?.close()" />
  </dialog>
</template>
