<script setup lang="ts">
import { computed, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import UiButton from "../common/UiButton.vue"
import UiDialog from "../common/UiDialog.vue"

const props = defineProps<{
  action?: "stop" | "archive" | "restore" | null
  context?: "directory" | "worktree"
}>()
const emit = defineEmits<{ close: []; confirm: [] }>()
const dialog = useTemplateRef<InstanceType<typeof UiDialog>>("dialog")
let confirmed = false
watch(() => props.action, () => { confirmed = false })
function confirm(): void { confirmed = true; dialog.value?.close() }
function closed(): void {
  if (confirmed) emit("confirm")
  else emit("close")
}
const { t } = useI18n()
const confirmationQuestion = computed(() => {
  if (props.action === "stop") return "agent.stopQuestion"
  if (props.action === "restore") return props.context === "worktree" ? "agent.restoreWorktreeQuestion" : "agent.restoreQuestion"
  return props.context === "worktree" ? "agent.archiveWorktreeQuestion" : "agent.archiveQuestion"
})
</script>

<template>
  <UiDialog ref="dialog" v-slot="{ close }" :open="!!action" :title="t('agent.sessionActions')" class="w-[24rem]" @close="closed">
    <p class="m-0 text-sm leading-relaxed">{{ t(confirmationQuestion) }}</p>
    <div class="ui-dialog-actions">
      <UiButton type="button" @click="close">{{ t('catalog.cancel') }}</UiButton>
      <UiButton :variant="action === 'archive' && context === 'worktree' ? 'danger' : 'primary'" type="button" @click="confirm">{{ t(action === 'stop' ? 'agent.stop' : action === 'restore' ? 'agent.restore' : 'agent.archive') }}</UiButton>
    </div>
  </UiDialog>
</template>
