<script setup lang="ts">
import {
  Archive,
  Bot,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  MonitorPlay,
  SquarePen,
  SquareTerminal,
} from "@lucide/vue"
import { useArrayFilter } from "@vueuse/core"
import { computed, ref } from "vue"
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui"
import { useI18n } from "vue-i18n"
import { useRouter, type RouteLocationRaw } from "vue-router"
import { intlLocale, type AppLocale } from "../../../../client/src/i18n.ts"
import type { MachineSummary, WorkspaceSummary } from "../../stores/fleet-types.ts"
import { useSessionLabel } from "../../composables/useSessionLabel.ts"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import IconButton from "../common/IconButton.vue"
import ProviderIcon from "../common/ProviderIcon.vue"
import WorkspaceCreateDialog from "../catalog/WorkspaceCreateDialog.vue"
import WorkspaceContextMenu from "../catalog/WorkspaceContextMenu.vue"
import SessionContextMenu from "../session/SessionContextMenu.vue"
import { sessionIsUnread, snapshotIsWorking } from "../../services/agent-conversation.ts"
import SessionUnreadIndicator from "./SessionUnreadIndicator.vue"
import SessionWorkingIndicator from "./SessionWorkingIndicator.vue"
import TreeLink from "./TreeLink.vue"

const props = defineProps<{ machine: MachineSummary }>()
const { t, locale } = useI18n()
const sessionLabel = useSessionLabel()
const agents = useAgentSessionsStore()
const fleet = useFleetStore()
const terminals = useTerminalsStore()
const router = useRouter()
const account = useAccountSession()
const addingWorkspace = ref(false)
const openingTerminal = ref(false)
const terminalError = ref<{ workspaceId: string; message: string } | null>(null)
const sessions = useArrayFilter(() => props.machine.sessions, session => session.archiveState !== "archived")
const workspaces = computed(() => props.machine.workspaces.map(workspace => ({
  ...workspace,
  sessions: workspace.sessions.filter(session => session.archiveState !== "archived"),
})))

function openRoute(destination: RouteLocationRaw): void {
  if (account) account.openMachineRoute(props.machine.id, destination)
  else void router.push(destination)
}

function workspaceCreated(id: string): void {
  addingWorkspace.value = false
  startSession(id)
}

function startSession(workspaceId: string): void {
  fleet.targetWorkspace(workspaceId)
  openRoute({ name: "new-session" })
}

async function openTerminal(workspace: WorkspaceSummary): Promise<void> {
  const cwd = workspace.directories[0]?.path
  if (!props.machine.online || openingTerminal.value || !cwd) return
  openingTerminal.value = true
  terminalError.value = null
  try {
    const terminal = await terminals.create({ cwd })
    openRoute({ name: "terminal", params: { terminalId: terminal.id } })
  } catch (reason) {
    terminalError.value = { workspaceId: workspace.id, message: reason instanceof Error ? reason.message : String(reason) }
  } finally {
    openingTerminal.value = false
  }
}

const collapsed = computed(() => fleet.isCollapsed(props.machine.id))
const lastSeen = computed(() => {
  if (!props.machine.lastSeen) return undefined
  const time = new Intl.DateTimeFormat(intlLocale(locale.value as AppLocale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(props.machine.lastSeen))
  return t("machine.lastSeen", { time })
})
const terminalLink = (terminalId: string) => ({ name: "terminal", params: { terminalId } })
const sessionWorking = (sessionId: string) => snapshotIsWorking(agents.views[sessionId]?.snapshot)
</script>

<template>
  <CollapsibleRoot as="section" :data-machine-id="machine.id" :open="!collapsed" class="mt-4 first:mt-0" @update:open="fleet.toggleMachine(machine.id)">
    <div class="group flex h-8 items-center gap-1 pl-2.5 pr-1">
      <CollapsibleTrigger
        type="button"
        class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-[13px] font-medium text-ui-text-muted hover:text-ui-text"
      >
        <span class="truncate">{{ machine.name }}</span>
        <span v-if="machine.local" class="ui-badge shrink-0 rounded-full font-normal">{{ t("machine.local") }}</span>
        <span
          v-if="!machine.online"
          class="ui-badge shrink-0 rounded-full font-normal"
          :title="lastSeen"
        >
          {{ t("machine.offline") }}
        </span>
        <ChevronRight v-if="collapsed" :size="14" class="shrink-0" aria-hidden="true" />
      </CollapsibleTrigger>
      <div v-if="machine.online" class="flex op-0 group-hover:op-100 group-focus-within:op-100">
        <IconButton :icon="FolderPlus" :label="t('machine.addWorkspace')" :placeholder="false" :disabled="!fleet.canManageCatalog" @click="addingWorkspace = true" />
      </div>
    </div>
    <WorkspaceCreateDialog v-if="addingWorkspace" @created="workspaceCreated" @cancel="addingWorkspace = false" />

    <CollapsibleContent as="ul" class="mt-1 flex flex-col gap-1">
      <li>
        <TreeLink
          :machine-id="machine.id"
          :to="{ name: 'machine-control', params: { machineId: machine.id } }"
          :icon="machine.local ? SquareTerminal : MonitorPlay"
          :label="t(machine.local ? 'machine.localControl' : 'machine.remoteControl')"
          :depth="0"
        />
      </li>
      <li v-for="session in sessions" :key="session.id">
        <SessionContextMenu v-slot="{ requestArchive, pending }" :machine-id="machine.id" :session-id="session.id" :title="session.title ?? ''" :context="session.context" :archive-state="session.archiveState" :disabled="!machine.online">
          <TreeLink
            :machine-id="machine.id"
            :to="{ name: 'session', params: { sessionId: session.id } }"
            :icon="Bot"
            :label="sessionLabel(session)"
            :depth="0"
          >
            <template #icon>
              <span v-if="!session.provider && !session.providerUnavailable" class="h-3.5 w-3.5 shrink-0 rounded bg-ui-border" data-provider-pending aria-hidden="true" />
              <ProviderIcon v-else :icon="session.providerIcon" :template="session.providerTemplate" :size="15" />
            </template>
            <template #trailing>
              <SessionWorkingIndicator v-if="sessionWorking(session.id)" />
              <SessionUnreadIndicator v-else-if="sessionIsUnread(session)" />
            </template>
            <template v-if="session.archiveState === 'active' || session.archiveState === 'archiving'" #actions>
              <IconButton
                :icon="Archive"
                :label="t(session.archiveState === 'archiving' ? 'agent.retryArchive' : 'agent.archive')"
                :disabled="!machine.online || pending || !session.context"
                @click="requestArchive()"
              />
            </template>
          </TreeLink>
        </SessionContextMenu>
      </li>
      <li v-if="workspaces.length === 0 && sessions.length === 0" class="h-8 px-2.5 leading-8 text-ui-text-faint">
        {{ t("machine.noWorkspaces") }}
      </li>
      <CollapsibleRoot v-for="workspace in workspaces" :key="workspace.id" v-slot="{ open }" as="li" default-open class="flex flex-col gap-1">
        <WorkspaceContextMenu :workspace-id="workspace.id" :machine-id="machine.id" :name="workspace.name" :directories="workspace.directories" :disabled="!machine.online || !fleet.canManageCatalog">
          <div class="workspace-row ui-nav-item relative">
            <CollapsibleTrigger type="button" :aria-label="workspace.name" class="relative flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 pl-2.5 pr-1 text-left">
              <component :is="open ? FolderOpen : Folder" :size="15" :stroke-width="1.75" class="workspace-folder-icon shrink-0" aria-hidden="true" />
              <ChevronRight :size="15" :stroke-width="1.75" class="workspace-collapse-icon absolute left-2.5 shrink-0" :class="open && 'rotate-90'" aria-hidden="true" />
              <span class="truncate">{{ workspace.name }}</span>
            </CollapsibleTrigger>
            <div class="workspace-actions flex shrink-0 items-center pr-1">
              <IconButton :icon="SquareTerminal" :label="t('workspace.openDefaultTerminal')" class="text-inherit enabled:hover:bg-transparent enabled:hover:text-inherit" :disabled="!machine.online || openingTerminal || workspace.directories.length === 0" @click="openTerminal(workspace)" />
              <IconButton :icon="SquarePen" :label="t('workspace.newSession')" class="text-inherit enabled:hover:bg-transparent enabled:hover:text-inherit" :disabled="!machine.online" @click="startSession(workspace.id)" />
            </div>
          </div>
        </WorkspaceContextMenu>
        <p v-if="terminalError?.workspaceId === workspace.id" role="alert" class="m-0 break-words px-2.5 text-xs text-ui-danger">{{ terminalError.message }}</p>
        <CollapsibleContent as="ul" class="flex flex-col gap-1 empty:hidden">
          <li v-for="terminal in workspace.terminals" :key="terminal.id">
            <TreeLink :machine-id="machine.id" :to="terminalLink(terminal.id)" :icon="SquareTerminal" :label="terminal.title" :depth="1" />
          </li>
          <li v-for="session in workspace.sessions" :key="session.id">
            <SessionContextMenu v-slot="{ requestArchive, pending }" :machine-id="machine.id" :session-id="session.id" :title="session.title ?? ''" :context="session.context" :archive-state="session.archiveState" :disabled="!machine.online">
              <!-- A Session's shells open in its bottom panel, not the sidebar. -->
              <TreeLink
                :machine-id="machine.id"
                :to="{ name: 'session', params: { sessionId: session.id } }"
                :icon="Bot"
                :label="sessionLabel(session)"
                :depth="1"
              >
                <template #icon>
                  <span v-if="!session.provider && !session.providerUnavailable" class="h-3.5 w-3.5 shrink-0 rounded bg-ui-border" data-provider-pending aria-hidden="true" />
                  <ProviderIcon v-else :icon="session.providerIcon" :template="session.providerTemplate" :size="15" />
                </template>
                <template #trailing>
                  <SessionWorkingIndicator v-if="sessionWorking(session.id)" />
                  <SessionUnreadIndicator v-else-if="sessionIsUnread(session)" />
                </template>
                <template v-if="session.archiveState === 'active' || session.archiveState === 'archiving'" #actions>
                  <IconButton
                    :icon="Archive"
                    :label="t(session.archiveState === 'archiving' ? 'agent.retryArchive' : 'agent.archive')"
                    :disabled="!machine.online || pending || !session.context"
                    @click="requestArchive()"
                  />
                </template>
              </TreeLink>
            </SessionContextMenu>
          </li>
        </CollapsibleContent>
      </CollapsibleRoot>
    </CollapsibleContent>
  </CollapsibleRoot>
</template>

<style scoped>
.workspace-folder-icon,
.workspace-collapse-icon,
.workspace-actions {
  transition: opacity 100ms ease-out, transform 100ms ease-out;
}

.workspace-collapse-icon,
.workspace-actions {
  opacity: 0;
}

.workspace-row:is(:hover, :has(:focus-visible)) .workspace-folder-icon {
  opacity: 0;
}

.workspace-row:is(:hover, :has(:focus-visible)) :is(.workspace-collapse-icon, .workspace-actions) {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .workspace-folder-icon,
  .workspace-collapse-icon,
  .workspace-actions {
    transition: none;
  }
}
</style>
