<script setup lang="ts">
import { DialogTitle } from "reka-ui"
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { CatalogDirectory } from "../../../../client/src/catalog.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import UiDialog from "../common/UiDialog.vue"
import OpenWithMenu from "./OpenWithMenu.vue"
import WorkspaceForm from "./WorkspaceForm.vue"

const props = defineProps<{ workspaceId: string; machineId: string; name: string; directories: CatalogDirectory[]; disabled?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const fleet = useFleetStore()
const platformClient = usePlatformClient()
const saving = ref(false)
const machine = computed(() => fleet.findMachine(props.machineId))
const applicationTarget = computed(() => platformClient.platform !== "web" && machine.value?.local && platformClient.applications
  ? { api: platformClient.applications, machineId: props.machineId, workspaceId: props.workspaceId } : undefined)
const browse = (path?: string) => platformClient.filesystem.listDirectories(path)

async function save(name: string, directories: CatalogDirectory[]): Promise<void> {
  saving.value = true
  try {
    await fleet.updateWorkspace(props.workspaceId, name, directories)
    emit("close")
  } finally { saving.value = false }
}
</script>

<template>
  <UiDialog class="w-[28rem]" :prevent-close="saving" @close="emit('close')">
    <div class="mb-5 flex items-center justify-between gap-3">
      <DialogTitle class="ui-dialog-title">{{ t('workspace.edit') }}</DialogTitle>
      <OpenWithMenu v-if="applicationTarget" v-bind="applicationTarget" :disabled="disabled || saving || directories.length === 0" />
    </div>
    <WorkspaceForm :initial="{ name, directories }" :submit-label="t('catalog.save')" :disabled="disabled" :browse="browse" :machine-name="machine?.name ?? ''" :save="save" @cancel="emit('close')" />
  </UiDialog>
</template>
