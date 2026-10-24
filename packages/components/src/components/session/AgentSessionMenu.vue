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
</script>

<template>
  <div ref="menu" class="app-no-drag relative">
    <IconButton :icon="Ellipsis" :label="t('agent.sessionActions')" :disabled="disabled" @click="open = !open" />
    <div v-if="open" role="menu" class="absolute top-full right-0 z-20 mt-1 flex w-44 flex-col rounded-lg border border-ui-border bg-ui-surface p-1 shadow-ui-card">
      <button v-if="canStop" type="button" role="menuitem" class="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-ui-hover" @click="choose('stop')"><Square :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t('agent.stop') }}</button>
      <button v-if="archiveState === 'archived'" type="button" role="menuitem" class="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-ui-hover" @click="choose('restore')"><ArchiveRestore :size="14" aria-hidden="true" />{{ t('agent.restore') }}</button>
      <button v-else type="button" role="menuitem" class="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-ui-hover" @click="choose('archive')"><Archive :size="14" aria-hidden="true" />{{ t(archiveState === 'archiving' ? 'agent.retryArchive' : 'agent.archive') }}</button>
    </div>
    <dialog ref="dialog" class="ui-dialog w-[24rem]" @close="confirming = null">
      <p class="m-0 mb-4 text-sm">{{ t(confirming === 'stop' ? 'agent.stopQuestion' : confirming === 'restore' ? 'agent.restoreQuestion' : 'agent.archiveQuestion') }}</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="catalog-button" @click="dialog?.close()">{{ t('catalog.cancel') }}</button>
        <button type="button" class="catalog-button" @click="confirm">{{ t(confirming === 'stop' ? 'agent.stop' : confirming === 'restore' ? 'agent.restore' : 'agent.archive') }}</button>
      </div>
    </dialog>
  </div>
</template>
