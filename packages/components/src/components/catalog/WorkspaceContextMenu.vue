<script setup lang="ts">
import { Pencil, Trash2 } from "@lucide/vue"
import { useAsyncState } from "@vueuse/core"
import { ContextMenuContent, ContextMenuItem, ContextMenuPortal, ContextMenuRoot, ContextMenuTrigger, DialogTitle } from "reka-ui"
import { ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import { useRoute, useRouter } from "vue-router"
import type { CatalogDirectory } from "../../../../client/src/catalog.ts"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import UiButton from "../common/UiButton.vue"
import UiDialog from "../common/UiDialog.vue"
import WorkspaceEditDialog from "./WorkspaceEditDialog.vue"

const props = defineProps<{ workspaceId: string; machineId: string; name: string; directories: CatalogDirectory[]; disabled?: boolean }>()
const { t } = useI18n()
const fleet = useFleetStore()
const account = useAccountSession()
const route = useRoute()
const router = useRouter()
const trigger = useTemplateRef<InstanceType<typeof ContextMenuTrigger>>("trigger")
const open = ref(false)
const dialog = ref<"edit" | "delete">()
const { isLoading: pending, error, executeImmediate: remove } = useAsyncState(async () => {
  const path = route.fullPath
  const ownsPage = activeWorkspace() === props.workspaceId
  await fleet.deleteWorkspace(props.workspaceId)
  dialog.value = undefined
  if (ownsPage && path === route.fullPath && selectedMachine()) await router.replace({ name: "new-session" })
}, undefined, { immediate: false })

function selectedMachine(): boolean {
  return !account || account.machineId.value === props.machineId
}
function activeWorkspace(): string | undefined {
  if (!selectedMachine()) return
  if (route.name === "session") return fleet.findSession(String(route.params.sessionId))?.workspace?.id
  if (route.name === "worktree") return fleet.findWorktree(String(route.params.worktreeId))?.workspace?.id
  if (route.name === "terminal") return fleet.findTerminal(String(route.params.terminalId))?.workspace?.id
}
function focusRow(): void {
  const element = trigger.value?.$el as HTMLElement | undefined
  element?.querySelector<HTMLElement>("button, a")?.focus()
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
function choose(action: "edit" | "delete"): void {
  if (props.disabled) return
  focusRow()
  open.value = false
  error.value = undefined
  dialog.value = action
}
function confirm(): void {
  if (!pending.value && !props.disabled) void remove()
}
</script>

<template>
  <ContextMenuRoot v-model:open="open" :modal="false">
    <ContextMenuTrigger ref="trigger" as="div" @keydown="keyboardOpen"><slot /></ContextMenuTrigger>
    <ContextMenuPortal>
      <ContextMenuContent :aria-label="name" :collision-padding="8" class="ui-menu z-50 flex w-48 flex-col" loop @close-auto-focus="closeFocus" @interact-outside="dialog && $event.preventDefault()">
        <ContextMenuItem as="button" type="button" class="ui-menu-item" :disabled="disabled" @select="choose('edit')"><Pencil :size="14" aria-hidden="true" />{{ t('workspace.edit') }}</ContextMenuItem>
        <ContextMenuItem as="button" type="button" class="ui-menu-item text-ui-danger" :disabled="disabled" @select="choose('delete')"><Trash2 :size="14" aria-hidden="true" />{{ t('workspace.delete') }}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
  <WorkspaceEditDialog v-if="dialog === 'edit'" v-bind="props" @close="dialog = undefined" />
  <UiDialog v-else-if="dialog === 'delete'" class="w-[24rem]" :prevent-close="pending" @close="dialog = undefined">
    <DialogTitle class="ui-dialog-title">{{ t('workspace.delete') }}</DialogTitle>
    <p class="m-0 mt-3 text-sm leading-relaxed">{{ t('workspace.deleteQuestion', { name }) }}</p>
    <p v-if="error" role="alert" class="mb-0 mt-3 text-sm text-ui-danger">{{ error instanceof Error ? error.message : String(error) }}</p>
    <div class="ui-dialog-actions">
      <UiButton type="button" :disabled="pending" @click="dialog = undefined">{{ t('catalog.cancel') }}</UiButton>
      <UiButton variant="danger" type="button" :disabled="pending || disabled" @click="confirm">{{ t('catalog.confirmDelete') }}</UiButton>
    </div>
  </UiDialog>
</template>
