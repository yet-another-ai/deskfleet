<script setup lang="ts">
import { Archive, ArchiveRestore, RefreshCw, Trash2 } from "@lucide/vue"
import { useAsyncState } from "@vueuse/core"
import { DialogTitle } from "reka-ui"
import { computed, onBeforeUnmount, ref } from "vue"
import { useI18n } from "vue-i18n"
import { RouterLink, useRouter } from "vue-router"
import { useAccountSession } from "../composables/useAccountSession.ts"
import { useSessionLabel } from "../composables/useSessionLabel.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { useFleetStore } from "../stores/fleet.ts"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import HoldButton from "../components/common/HoldButton.vue"
import IconButton from "../components/common/IconButton.vue"
import UiButton from "../components/common/UiButton.vue"
import UiDialog from "../components/common/UiDialog.vue"
import UiSelect from "../components/common/UiSelect.vue"
import SessionContextMenu from "../components/session/SessionContextMenu.vue"

const { t } = useI18n()
const router = useRouter()
const account = useAccountSession()
const sessionLabel = useSessionLabel()
const agents = useAgentSessionsStore()
const fleet = useFleetStore()
const confirmingId = ref<string>()
const confirmingAction = ref<"restore" | "delete">("restore")
const restoreError = ref<string>()
const busy = ref(false)
let disposed = false
onBeforeUnmount(() => { disposed = true })

const archived = computed(() => Object.values(agents.sessions)
  .filter(session => session.archiveState === "archived")
  .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  .map(session => {
    const location = fleet.findSession(session.id)
    return {
      session,
      title: sessionLabel(session),
      machine: location?.machine,
      workspace: location?.workspace,
      online: location?.machine.online ?? fleet.localDesktopTarget.online,
    }
  }))
const confirming = computed(() => archived.value.find(item => item.session.id === confirmingId.value))
const { isLoading, error: loadError, executeImmediate: refresh } = useAsyncState(async () => {
  agents.error = null
  await agents.refresh()
  if (agents.error) throw new Error(agents.error)
}, undefined, { onError: () => {} }) // Load failures are shown below with a retry action.
const loadMessage = computed(() => loadError.value instanceof Error ? loadError.value.message : String(loadError.value))

function requestAction(sessionId: string, action: "restore" | "delete"): void {
  restoreError.value = undefined
  confirmingAction.value = action
  confirmingId.value = sessionId
}
async function confirmAction(): Promise<void> {
  const item = confirming.value
  if (!item || !item.online || busy.value) return
  busy.value = true
  restoreError.value = undefined
  try {
    if (confirmingAction.value === "delete") {
      await agents.remove(item.session.id)
      confirmingId.value = undefined
    } else {
      await agents.restore(item.session.id)
      confirmingId.value = undefined
      if (!disposed) await router.push({ name: "session", params: { sessionId: item.session.id } })
    }
  } catch (reason) {
    restoreError.value = reason instanceof Error ? reason.message : String(reason)
  } finally { busy.value = false }
}
</script>

<template>
  <PaneHeader hide-details>{{ t('archivedSessions.title') }}</PaneHeader>
  <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-10 pt-6 lg:px-8">
    <div class="mx-auto flex max-w-4xl flex-col gap-5">
      <div class="flex flex-wrap items-end justify-between gap-4">
        <div class="min-w-0">
          <h1 class="ui-page-title">{{ t('archivedSessions.title') }}</h1>
          <p class="m-0 mt-1 text-sm text-ui-text-muted">{{ t('archivedSessions.description') }}</p>
        </div>
        <div class="flex items-center gap-2">
          <UiSelect v-if="account && account.machines.value.length > 1" class="w-auto max-w-48" name="archive-machine" :aria-label="t('archivedSessions.machine')" :model-value="fleet.targetId" :options="account.machines.value.map(machine => ({ value: machine.id, label: machine.name }))" :disabled="busy" @update:model-value="account.selectMachine($event)" />
          <UiButton type="button" class="px-2" :aria-label="t('catalog.refresh')" :title="t('catalog.refresh')" :disabled="isLoading || busy" @click="refresh()"><RefreshCw :size="14" aria-hidden="true" /></UiButton>
        </div>
      </div>
      <div v-if="loadError" class="ui-notice m-0 justify-between border-ui-danger/30 bg-ui-danger/8">
        <p role="alert" class="m-0 text-ui-danger">{{ loadMessage }}</p>
        <UiButton type="button" :disabled="isLoading" @click="refresh()">{{ t('folderPicker.retry') }}</UiButton>
      </div>
      <p v-if="isLoading && !archived.length" role="status" class="m-0 py-6 text-sm text-ui-text-muted">{{ t('archivedSessions.loading') }}</p>
      <div v-else-if="!archived.length && !loadError" class="ui-empty">
        <Archive :size="25" class="mb-2 text-ui-text-muted" aria-hidden="true" />
        <p class="m-0 text-sm font-medium">{{ t('archivedSessions.empty') }}</p>
        <p class="m-0 max-w-sm text-[13px] leading-5 text-ui-text-muted">{{ t('archivedSessions.emptyDescription') }}</p>
      </div>
      <ul v-else-if="archived.length" class="ui-card m-0 list-none p-0" :aria-label="t('archivedSessions.title')">
        <li v-for="(item, index) in archived" :key="item.session.id" class="px-4 py-3" :class="index > 0 && 'border-t border-ui-border'" :data-archived-session="item.session.id">
          <SessionContextMenu :machine-id="item.machine?.id" :session-id="item.session.id" :title="item.session.title" :archive-state="item.session.archiveState" :disabled="!item.online || busy">
            <div class="flex items-center gap-3">
              <RouterLink :to="{ name: 'session', params: { sessionId: item.session.id } }" class="min-w-0 flex-1 rounded-md text-inherit no-underline hover:text-ui-accent" :aria-label="t('archivedSessions.openLabel', { title: item.title })">
                <span class="block truncate text-sm">{{ item.title }}</span>
                <span v-if="item.machine" class="block truncate text-[13px] text-ui-text-muted">{{ item.workspace ? t('archivedSessions.location', { machine: item.machine.name, workspace: item.workspace.name }) : item.machine.name }}</span>
              </RouterLink>
              <span v-if="!item.online" class="ui-badge shrink-0 rounded-full font-normal">{{ t('machine.offline') }}</span>
              <IconButton :icon="ArchiveRestore" :label="t('archivedSessions.restoreLabel', { title: item.title })" :disabled="!item.online || busy" :data-restore-session="item.session.id" @click="requestAction(item.session.id, 'restore')" />
              <IconButton :icon="Trash2" :label="t('archivedSessions.deleteLabel', { title: item.title })" :disabled="!item.online || busy" :data-delete-session="item.session.id" @click="requestAction(item.session.id, 'delete')" />
            </div>
          </SessionContextMenu>
        </li>
      </ul>
    </div>
  </div>
  <UiDialog v-if="confirming" class="w-[24rem]" :prevent-close="busy" @close="confirmingId = undefined">
    <DialogTitle class="ui-dialog-title">{{ t(confirmingAction === 'delete' ? 'agent.delete' : 'agent.restore') }}</DialogTitle>
    <p class="m-0 text-sm leading-relaxed">{{ t(confirmingAction === 'delete' ? (confirming.session.context === 'directory' ? 'agent.deleteDirectoryQuestion' : 'agent.deleteQuestion') : 'agent.restoreQuestion') }}</p>
    <p v-if="restoreError" role="alert" class="m-0 mt-3 text-sm text-ui-danger">{{ restoreError }}</p>
    <div class="ui-dialog-actions">
      <UiButton type="button" :disabled="busy" @click="confirmingId = undefined">{{ t('catalog.cancel') }}</UiButton>
      <HoldButton v-if="confirmingAction === 'delete'" variant="danger" :text="t('agent.delete')" :hold-label="t('agent.holdToConfirm')" :disabled="busy || !confirming.online" data-confirm-delete @confirm="confirmAction" />
      <UiButton v-else variant="primary" type="button" :disabled="busy || !confirming.online" data-confirm-restore @click="confirmAction">{{ t('agent.restore') }}</UiButton>
    </div>
  </UiDialog>
</template>
