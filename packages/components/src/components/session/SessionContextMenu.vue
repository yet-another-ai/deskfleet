<script setup lang="ts">
import { Archive, ArchiveRestore, Pencil, Pin, PinOff } from "@lucide/vue"
import { ContextMenuContent, ContextMenuItem, ContextMenuPortal, ContextMenuRoot, ContextMenuTrigger, DialogTitle } from "reka-ui"
import { computed, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { usePinnedSessionsStore } from "../../stores/pinned-sessions.ts"
import UiButton from "../common/UiButton.vue"
import UiDialog from "../common/UiDialog.vue"
import RenameSessionDialog from "./RenameSessionDialog.vue"

const props = defineProps<{ sessionId: string; machineId?: string; title: string; archiveState?: "active" | "archiving" | "archived"; disabled?: boolean }>()
const { t } = useI18n()
const agents = useAgentSessionsStore()
const fleet = useFleetStore()
const pins = usePinnedSessionsStore()
const machineId = computed(() => props.machineId ?? fleet.targetId)
const pinned = computed(() => pins.isPinned(machineId.value, props.sessionId))
const trigger = useTemplateRef<InstanceType<typeof ContextMenuTrigger>>("trigger")
const open = ref(false)
const dialog = ref<"rename" | "archive" | "restore">()
const pending = ref(false)
const error = ref<string>()

function focusRow(): void {
  const element = trigger.value?.$el as HTMLElement | undefined
  element?.querySelector<HTMLElement>("a, button")?.focus()
}
function keyboardOpen(event: KeyboardEvent): void {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return
  event.preventDefault()
  open.value = true
}
function closeFocus(event: Event): void {
  event.preventDefault()
  if (!dialog.value) focusRow()
}
function choose(action: "rename" | "archive" | "restore"): void {
  // Capture a durable row as the dialog's focus target before the menu unmounts.
  focusRow()
  open.value = false
  error.value = undefined
  dialog.value = action
}
function togglePin(): void {
  open.value = false
  if (pinned.value) pins.unpin(machineId.value, props.sessionId)
  else pins.pin(machineId.value, props.sessionId, props.title)
}
async function confirm(): Promise<void> {
  if (pending.value || props.disabled) return
  pending.value = true
  error.value = undefined
  try {
    if (dialog.value === "restore") await agents.restore(props.sessionId)
    else await agents.archive(props.sessionId)
    dialog.value = undefined
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { pending.value = false }
}
</script>

<template>
  <ContextMenuRoot v-model:open="open" :modal="false">
    <ContextMenuTrigger ref="trigger" as="div" @keydown="keyboardOpen"><slot /></ContextMenuTrigger>
    <ContextMenuPortal>
      <ContextMenuContent :aria-label="t('agent.sessionActions')" :collision-padding="8" class="ui-menu z-50 flex w-44 flex-col" loop @close-auto-focus="closeFocus" @interact-outside="dialog && $event.preventDefault()">
        <ContextMenuItem as="button" type="button" class="ui-menu-item" @select="togglePin"><component :is="pinned ? PinOff : Pin" :size="14" aria-hidden="true" />{{ t(pinned ? 'agent.unpin' : 'agent.pin') }}</ContextMenuItem>
        <ContextMenuItem as="button" type="button" class="ui-menu-item" :disabled="disabled || !archiveState" @select="choose('rename')"><Pencil :size="14" aria-hidden="true" />{{ t('agent.rename') }}</ContextMenuItem>
        <ContextMenuItem v-if="archiveState === 'archived'" as="button" type="button" class="ui-menu-item" :disabled="disabled" @select="choose('restore')"><ArchiveRestore :size="14" aria-hidden="true" />{{ t('agent.restore') }}</ContextMenuItem>
        <ContextMenuItem v-else as="button" type="button" class="ui-menu-item" :disabled="disabled || !archiveState" @select="choose('archive')"><Archive :size="14" aria-hidden="true" />{{ t(archiveState === 'archiving' ? 'agent.retryArchive' : 'agent.archive') }}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
  <RenameSessionDialog v-if="dialog === 'rename'" :title="title" :disabled="disabled" :confirm="value => agents.rename(sessionId, value)" @close="dialog = undefined" />
  <UiDialog v-else-if="dialog" class="w-[24rem]" :prevent-close="pending" @close="dialog = undefined">
    <DialogTitle class="ui-dialog-title">{{ t(dialog === 'restore' ? 'agent.restore' : 'agent.archive') }}</DialogTitle>
    <p class="m-0 mt-3 text-sm leading-relaxed">{{ t(dialog === 'restore' ? 'agent.restoreQuestion' : 'agent.archiveQuestion') }}</p>
    <p v-if="error" role="alert" class="mb-0 mt-3 text-sm text-ui-danger">{{ error }}</p>
    <div class="ui-dialog-actions">
      <UiButton type="button" :disabled="pending" @click="dialog = undefined">{{ t('catalog.cancel') }}</UiButton>
      <UiButton variant="primary" type="button" :disabled="pending || disabled" @click="confirm">{{ t(dialog === 'restore' ? 'agent.restore' : 'agent.archive') }}</UiButton>
    </div>
  </UiDialog>
</template>
