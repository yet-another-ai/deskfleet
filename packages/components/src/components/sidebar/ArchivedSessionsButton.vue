<script setup lang="ts">
import { Archive, ArchiveRestore } from "@lucide/vue"
import { DialogTitle } from "reka-ui"
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { useRouter } from "vue-router"
import { useSessionLabel } from "../../composables/useSessionLabel.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import SessionContextMenu from "../session/SessionContextMenu.vue"
import IconButton from "../common/IconButton.vue"
import UiButton from "../common/UiButton.vue"
import UiDialog from "../common/UiDialog.vue"

const { t } = useI18n()
const router = useRouter()
const sessionLabel = useSessionLabel()
const agents = useAgentSessionsStore()
const fleet = useFleetStore()
const open = ref(false)
const restoringId = ref<string>()
const confirmingId = ref<string>()
const error = ref<string>()
const busy = ref(false)

const archived = computed(() => Object.values(agents.sessions)
  .filter(session => session.archiveState === "archived")
  .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  .map(session => {
    const location = fleet.findSession(session.id)
    return {
      session,
      title: sessionLabel(location?.session ?? session),
      machine: location?.machine,
      workspace: location?.workspace,
      online: location?.machine.online ?? fleet.localDesktopTarget.online,
    }
  }))

const confirming = computed(() => archived.value.find(item => item.session.id === confirmingId.value))

async function show(): Promise<void> {
  open.value = true
  error.value = undefined
  confirmingId.value = undefined
  void agents.refresh()
}

function close(): void {
  if (busy.value) return
  open.value = false
  confirmingId.value = undefined
  error.value = undefined
}

async function openSession(sessionId: string): Promise<void> {
  close()
  await router.push({ name: "session", params: { sessionId } })
}

function requestRestore(sessionId: string): void {
  error.value = undefined
  confirmingId.value = sessionId
}

async function confirmRestore(): Promise<void> {
  const sessionId = confirmingId.value
  if (!sessionId || busy.value) return
  busy.value = true
  restoringId.value = sessionId
  error.value = undefined
  try {
    await agents.restore(sessionId)
    confirmingId.value = undefined
    open.value = false
    await router.push({ name: "session", params: { sessionId } })
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    restoringId.value = undefined
    busy.value = false
  }
}
</script>

<template>
  <IconButton :icon="Archive" :label="t('archivedSessions.title')" data-archived-sessions @click="show" />
  <UiDialog v-if="open" class="w-[28rem]" :prevent-close="busy" @close="close">
    <DialogTitle class="ui-dialog-title">{{ t("archivedSessions.title") }}</DialogTitle>
    <p class="ui-dialog-description">{{ t("archivedSessions.description") }}</p>
    <div v-if="!archived.length" class="ui-empty mt-4">
      <p class="m-0 text-sm">{{ t("archivedSessions.empty") }}</p>
      <p class="m-0 max-w-sm text-[13px] text-ui-text-muted">{{ t("archivedSessions.emptyDescription") }}</p>
    </div>
    <ul v-else class="ui-card mt-4 max-h-[min(24rem,50dvh)] list-none overflow-y-auto p-0" :aria-label="t('archivedSessions.title')">
      <li
        v-for="(item, index) in archived"
        :key="item.session.id"
        class="px-4 py-3"
        :class="index > 0 && 'border-t border-ui-border'"
        :data-archived-session="item.session.id"
      >
        <SessionContextMenu :session-id="item.session.id" :title="item.session.title" :archive-state="item.session.archiveState" :disabled="!item.online || busy">
          <div class="flex items-center gap-3">
            <button
              type="button"
              class="min-w-0 flex-1 cursor-pointer rounded-md text-left hover:text-ui-accent"
              :aria-label="t('archivedSessions.openLabel', { title: item.title })"
              @click="openSession(item.session.id)"
            >
              <span class="block truncate text-sm">{{ item.title }}</span>
              <span v-if="item.machine && item.workspace" class="block truncate text-[13px] text-ui-text-muted">
                {{ t("archivedSessions.location", { machine: item.machine.name, workspace: item.workspace.name }) }}
              </span>
            </button>
            <IconButton
              :icon="ArchiveRestore"
              :label="t('archivedSessions.restoreLabel', { title: item.title })"
              :disabled="!item.online || restoringId === item.session.id"
              :data-restore-session="item.session.id"
              @click="requestRestore(item.session.id)"
            />
          </div>
        </SessionContextMenu>
      </li>
    </ul>
    <p v-if="error && !confirming" role="alert" class="m-0 mt-3 text-sm text-ui-danger">{{ error }}</p>
    <div class="ui-dialog-actions">
      <UiButton type="button" :disabled="busy" @click="close">{{ t("catalog.cancel") }}</UiButton>
    </div>
  </UiDialog>
  <UiDialog v-if="confirming" class="w-[24rem]" :prevent-close="busy" @close="confirmingId = undefined">
    <DialogTitle class="ui-dialog-title">{{ t("agent.restore") }}</DialogTitle>
    <p class="m-0 text-sm leading-relaxed">{{ t("agent.restoreQuestion") }}</p>
    <p v-if="error" role="alert" class="m-0 mt-3 text-sm text-ui-danger">{{ error }}</p>
    <div class="ui-dialog-actions">
      <UiButton type="button" :disabled="busy" @click="confirmingId = undefined">{{ t("catalog.cancel") }}</UiButton>
      <UiButton variant="primary" type="button" :disabled="busy" data-confirm-restore @click="confirmRestore">{{ t("agent.restore") }}</UiButton>
    </div>
  </UiDialog>
</template>
