<script setup lang="ts">
import { usePlatformClient } from "../../composables/usePlatformClient.ts"

import { DialogTitle } from "reka-ui"
import { ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { CatalogDirectory } from "../../../../client/src/catalog.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import WorkspaceForm from "./WorkspaceForm.vue"
import UiDialog from "../common/UiDialog.vue"

const platformClient = usePlatformClient()

const emit = defineEmits<{ created: [id: string]; cancel: [] }>()
const dialog = useTemplateRef<InstanceType<typeof UiDialog>>("dialog")
const { t } = useI18n()
const fleet = useFleetStore()
const browseDirectories = (path?: string) => platformClient.filesystem.listDirectories(path)
const saving = ref(false)
let created: string | undefined

async function create(name: string, directories: CatalogDirectory[]): Promise<void> {
  saving.value = true
  try {
    const { id } = await fleet.createWorkspace(name, directories)
    created = id
    dialog.value?.close()
  } finally { saving.value = false }
}

function closed(): void {
  if (created) emit("created", created)
  else emit("cancel")
}
</script>

<template>
  <UiDialog ref="dialog" v-slot="{ close }" class="w-[28rem]" :prevent-close="saving" @close="closed">
    <DialogTitle class="ui-dialog-title mb-5">{{ t("catalog.newWorkspace", { machine: fleet.localDesktopTarget.name }) }}</DialogTitle>
    <WorkspaceForm :submit-label="t('catalog.create')" :disabled="!fleet.canManageCatalog" :browse="browseDirectories" :machine-name="fleet.localDesktopTarget.name" :save="create" @cancel="close" />
  </UiDialog>
</template>
