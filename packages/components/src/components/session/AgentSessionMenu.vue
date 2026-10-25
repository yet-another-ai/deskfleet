<script setup lang="ts">
import { Archive, ArchiveRestore, Ellipsis, Square } from "@lucide/vue"
import { onClickOutside } from "@vueuse/core"
import { nextTick, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import IconButton from "../common/IconButton.vue"
/** Archival closes execution while retaining the conversation and working context. */
defineProps<{ canStop: boolean; disabled: boolean; archiveState: "active" | "archiving" | "archived" }>()
const emit = defineEmits<{ stop: []; archive: []; restore: [] }>()
const { t } = useI18n()
const menu = useTemplateRef<HTMLElement>("menu")
const dialog = useTemplateRef<HTMLDialogElement>("dialog")
const open = ref(false)
const confirming = ref<"stop" | "archive" | "restore" | null>(null)
onClickOutside(menu, () => { open.value = false })
async function choose(kind: "stop" | "archive" | "restore"): Promise<void> {
  open.value = false
  confirming.value = kind
  await nextTick()
  dialog.value?.showModal()
}
function confirm(): void {
  const kind = confirming.value
  dialog.value?.close()
  if (kind === "stop") emit("stop")
  else if (kind === "archive") emit("archive")
  else if (kind === "restore") emit("restore")
}
function closed(): void {
  // A previous close event can arrive after this dialog has reopened.
  if (!dialog.value?.open) confirming.value = null
}
</script>

<template>
  <div ref="menu" class="app-no-drag relative">
    <IconButton :icon="Ellipsis" :label="t('agent.sessionActions')" :disabled="disabled" @click="open = !open" />
    <div v-if="open" role="menu" class="ui-menu absolute top-full right-0 z-20 mt-1 flex w-44 flex-col">
      <button v-if="canStop" type="button" role="menuitem" class="ui-menu-item" @click="choose('stop')"><Square :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t('agent.stop') }}</button>
      <button v-if="archiveState === 'archived'" type="button" role="menuitem" class="ui-menu-item" @click="choose('restore')"><ArchiveRestore :size="14" aria-hidden="true" />{{ t('agent.restore') }}</button>
      <button v-else type="button" role="menuitem" class="ui-menu-item" @click="choose('archive')"><Archive :size="14" aria-hidden="true" />{{ t(archiveState === 'archiving' ? 'agent.retryArchive' : 'agent.archive') }}</button>
    </div>
    <dialog ref="dialog" class="ui-dialog w-[24rem]" @close="closed">
      <p class="m-0 text-sm leading-relaxed">{{ t(confirming === 'stop' ? 'agent.stopQuestion' : confirming === 'restore' ? 'agent.restoreQuestion' : 'agent.archiveQuestion') }}</p>
      <div class="ui-dialog-actions">
        <button type="button" class="ui-button" @click="dialog?.close()">{{ t('catalog.cancel') }}</button>
        <button type="button" class="ui-button-primary" @click="confirm">{{ t(confirming === 'stop' ? 'agent.stop' : confirming === 'restore' ? 'agent.restore' : 'agent.archive') }}</button>
      </div>
    </dialog>
  </div>
</template>
