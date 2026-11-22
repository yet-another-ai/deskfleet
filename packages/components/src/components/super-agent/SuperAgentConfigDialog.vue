<script setup lang="ts">
import { DialogDescription, DialogTitle } from "reka-ui"
import { useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { CentralApi, Machine } from "@deskfleet/client/central"
import type { SuperAgentConfig } from "@deskfleet/client/super-agent"
import UiDialog from "../common/UiDialog.vue"
import SuperAgentConfigForm from "./SuperAgentConfigForm.vue"

defineProps<{
  teamId: string
  config: SuperAgentConfig
  machines: readonly Machine[]
  localMachineId?: string
  api: Pick<CentralApi, "catalog" | "rpc" | "updateSuperAgentConfig">
}>()
const emit = defineEmits<{ saved: [config: SuperAgentConfig]; close: [] }>()
const { t } = useI18n()
const dialog = useTemplateRef<InstanceType<typeof UiDialog>>("dialog")

function onSaved(updated: SuperAgentConfig): void {
  emit("saved", updated)
  dialog.value?.close()
}
</script>

<template>
  <UiDialog ref="dialog" class="w-[34rem] max-w-[calc(100vw-2rem)]" described @close="emit('close')">
    <DialogTitle class="ui-dialog-title">{{ t("superAgent.configTitle") }}</DialogTitle>
    <DialogDescription class="ui-dialog-description">{{ t("superAgent.configDescription") }}</DialogDescription>
    <div class="mt-4">
      <SuperAgentConfigForm
        :team-id="teamId"
        :config="config"
        :machines="machines"
        :local-machine-id="localMachineId"
        :api="api"
        show-cancel
        @saved="onSaved"
        @cancel="dialog?.close()"
      />
    </div>
  </UiDialog>
</template>
