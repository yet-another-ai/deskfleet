<script setup lang="ts">
import { FolderSync } from "@lucide/vue"
import { client } from "@deskfleet/client/platform"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { useFileTarget } from "../../composables/useFileTarget.ts"
import IconButton from "../common/IconButton.vue"
import FileTransferDialog from "./FileTransferDialog.vue"
const props = defineProps<{ machineId: string; machineName: string; compact?: boolean }>()
const { t } = useI18n()
const open = ref(false)
const target = useFileTarget(() => props.machineId)
const api = client.files
</script>

<template>
  <template v-if="api && target">
    <IconButton v-if="compact" :icon="FolderSync" :label="t('files.title')" @click="open = true" />
    <button v-else type="button" class="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] text-ui-text-muted hover:bg-ui-hover hover:text-ui-text" @click="open = true"><FolderSync :size="16" :stroke-width="1.75" aria-hidden="true" />{{ t('files.title') }}</button>
    <FileTransferDialog v-if="open" :key="target.kind === 'machine' ? `${target.teamId}:${target.machineId}` : 'local'" :api="api" :target="target" :machine-name="machineName" @close="open = false" />
  </template>
</template>
