<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import { Archive, ArchiveRestore, Ellipsis, GitFork, Pencil, Square } from "@lucide/vue"
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from "reka-ui"
import { ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import IconButton from "../common/IconButton.vue"
import UiDialog from "../common/UiDialog.vue"
/** Archival closes execution while retaining the conversation and working context. */
defineProps<{ canStop: boolean; canFork?: boolean; forkDisabled?: boolean; disabled: boolean; archiveState: "active" | "archiving" | "archived" }>()
const emit = defineEmits<{ stop: []; archive: []; restore: []; fork: []; rename: [] }>()
const { t } = useI18n()
const actions = useTemplateRef<HTMLElement>("actions")
const open = ref(false)
const openingDialog = ref(false)
const confirming = ref<"stop" | "archive" | "restore" | null>(null)
function changeOpen(value: boolean): void {
  open.value = value
  if (value) openingDialog.value = false
}
function openDialog(kind: "fork" | "rename"): void {
  openingDialog.value = true
  open.value = false
  actions.value?.querySelector<HTMLButtonElement>("button")?.focus()
  if (kind === "fork") emit("fork")
  else emit("rename")
}
function choose(kind: "stop" | "archive" | "restore"): void {
  open.value = false
  confirming.value = kind
}
function confirm(): void {
  const kind = confirming.value
  confirming.value = null
  if (kind === "stop") emit("stop")
  else if (kind === "archive") emit("archive")
  else if (kind === "restore") emit("restore")
}
function restoreFocus(event: Event): void {
  event.preventDefault()
  actions.value?.querySelector<HTMLButtonElement>("button")?.focus()
}
</script>

<template>
  <div ref="actions" class="app-no-drag">
    <DropdownMenuRoot :open="open" :modal="false" @update:open="changeOpen">
      <DropdownMenuTrigger :as="IconButton" :icon="Ellipsis" :label="t('agent.sessionActions')" :disabled="disabled" />
      <DropdownMenuPortal>
        <DropdownMenuContent align="end" :side-offset="4" :collision-padding="8" :aria-label="t('agent.sessionActions')" class="ui-menu z-50 flex w-44 flex-col" @close-auto-focus="(confirming || openingDialog) && $event.preventDefault()" @interact-outside="openingDialog && $event.preventDefault()" loop>
          <DropdownMenuItem as="button" type="button" class="ui-menu-item" @select="openDialog('rename')"><Pencil :size="14" aria-hidden="true" />{{ t('agent.rename') }}</DropdownMenuItem>
          <DropdownMenuItem v-if="canFork" as="button" type="button" class="ui-menu-item" :disabled="disabled || forkDisabled" @select="openDialog('fork')"><GitFork :size="14" aria-hidden="true" />{{ t('agent.fork') }}</DropdownMenuItem>
          <DropdownMenuItem v-if="canStop" as="button" type="button" class="ui-menu-item" @select="choose('stop')"><Square :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t('agent.stop') }}</DropdownMenuItem>
          <DropdownMenuItem v-if="archiveState === 'archived'" as="button" type="button" class="ui-menu-item" @select="choose('restore')"><ArchiveRestore :size="14" aria-hidden="true" />{{ t('agent.restore') }}</DropdownMenuItem>
          <DropdownMenuItem v-else as="button" type="button" class="ui-menu-item" @select="choose('archive')"><Archive :size="14" aria-hidden="true" />{{ t(archiveState === 'archiving' ? 'agent.retryArchive' : 'agent.archive') }}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
    <UiDialog :open="!!confirming" :title="t('agent.sessionActions')" class="w-[24rem]" @close="confirming = null" @close-auto-focus="restoreFocus">
      <p class="m-0 text-sm leading-relaxed">{{ t(confirming === 'stop' ? 'agent.stopQuestion' : confirming === 'restore' ? 'agent.restoreQuestion' : 'agent.archiveQuestion') }}</p>
      <div class="ui-dialog-actions">
        <UiButton type="button" @click="confirming = null">{{ t('catalog.cancel') }}</UiButton>
        <UiButton variant="primary" type="button" @click="confirm">{{ t(confirming === 'stop' ? 'agent.stop' : confirming === 'restore' ? 'agent.restore' : 'agent.archive') }}</UiButton>
      </div>
    </UiDialog>
  </div>
</template>
