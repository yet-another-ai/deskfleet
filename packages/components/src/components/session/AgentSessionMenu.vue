<script setup lang="ts">
import { Ellipsis, Square, Trash2 } from "@lucide/vue"
import { onClickOutside } from "@vueuse/core"
import { nextTick, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import IconButton from "../common/IconButton.vue"
/** A directory Session's deletion leaves the Workspace's files in place. */
defineProps<{ canStop: boolean; disabled: boolean; directory?: boolean }>()
const emit = defineEmits<{ stop: []; delete: [] }>()
const { t } = useI18n()
const menu = useTemplateRef<HTMLElement>("menu")
const dialog = useTemplateRef<HTMLDialogElement>("dialog")
const open = ref(false)
const confirming = ref<"stop" | "delete" | null>(null)
onClickOutside(menu, () => { open.value = false })
async function choose(kind: "stop" | "delete"): Promise<void> {
  open.value = false
  confirming.value = kind
  await nextTick()
  dialog.value?.showModal()
}
function confirm(): void {
  const kind = confirming.value
  dialog.value?.close()
  if (kind === "stop") emit("stop")
  else if (kind === "delete") emit("delete")
}
</script>

<template>
  <div ref="menu" class="app-no-drag relative">
    <IconButton :icon="Ellipsis" :label="t('agent.sessionActions')" :disabled="disabled" @click="open = !open" />
    <div v-if="open" role="menu" class="absolute top-full right-0 z-20 mt-1 flex w-44 flex-col rounded-lg border border-ui-border bg-ui-surface p-1 shadow-ui-card">
      <button v-if="canStop" type="button" role="menuitem" class="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-ui-hover" @click="choose('stop')"><Square :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t('agent.stop') }}</button>
      <button type="button" role="menuitem" class="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] text-ui-danger hover:bg-ui-hover" @click="choose('delete')"><Trash2 :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t('agent.delete') }}</button>
    </div>
    <dialog ref="dialog" class="ui-dialog w-[24rem]" @close="confirming = null">
      <p class="m-0 mb-4 text-sm">{{ t(confirming === 'stop' ? 'agent.stopQuestion' : directory ? 'agent.deleteDirectoryQuestion' : 'agent.deleteQuestion') }}</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="catalog-button" @click="dialog?.close()">{{ t('catalog.cancel') }}</button>
        <button type="button" class="catalog-button" :class="confirming === 'delete' && 'text-ui-danger'" @click="confirm">{{ t(confirming === 'stop' ? 'agent.stop' : 'catalog.confirmDelete') }}</button>
      </div>
    </dialog>
  </div>
</template>
