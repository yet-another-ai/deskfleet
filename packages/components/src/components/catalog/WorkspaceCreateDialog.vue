<script setup lang="ts">
import { usePlatformClient } from "../../composables/usePlatformClient.ts"

import { DialogTitle } from "reka-ui"
import { useI18n } from "vue-i18n"
import type { CatalogDirectory } from "../../../../client/src/catalog.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import WorkspaceForm from "./WorkspaceForm.vue"
import UiDialog from "../common/UiDialog.vue"

const platformClient = usePlatformClient()

const emit = defineEmits<{ created: [id: string]; cancel: [] }>()
const { t } = useI18n()
const fleet = useFleetStore()
const browseDirectories = (path?: string) => platformClient.filesystem.listDirectories(path)
let created = false

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
  <UiDialog class="w-[28rem]" @close="closed">
    <DialogTitle class="ui-dialog-title mb-5">{{ t("catalog.newWorkspace", { machine: fleet.localDesktopTarget.name }) }}</DialogTitle>
    <WorkspaceForm :submit-label="t('catalog.create')" :disabled="!fleet.canManageCatalog" :browse="browseDirectories" :machine-name="fleet.localDesktopTarget.name" :save="create" @cancel="closed" />
  </UiDialog>
</template>
