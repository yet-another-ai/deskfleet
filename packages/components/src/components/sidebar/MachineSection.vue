<script setup lang="ts">
import {
  Bot,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  LocateFixed,
  MonitorPlay,
  Plus,
  SquarePen,
  SquareTerminal,
  Unplug,
} from "@lucide/vue"
import { computedAsync, useArrayFilter } from "@vueuse/core"
import { computed, ref } from "vue"
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui"
import { useI18n } from "vue-i18n"
import { useRoute, useRouter, type RouteLocationRaw } from "vue-router"
import { intlLocale, type AppLocale } from "../../../../client/src/i18n.ts"
import type { AgentSessionSummary, MachineSummary, WorkspaceSummary } from "../../stores/fleet-types.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useMachineRuntimes } from "../../composables/useMachineRuntimes.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import UiButton from "../common/UiButton.vue"
import WorkspaceCreateDialog from "../catalog/WorkspaceCreateDialog.vue"
import WorkspaceContextMenu from "../catalog/WorkspaceContextMenu.vue"
import { sessionIsUnread, type SessionActivity } from "../../services/agent-conversation.ts"
import SessionUnreadIndicator from "./SessionUnreadIndicator.vue"
import SessionWorkingIndicator from "./SessionWorkingIndicator.vue"
import { isPrivateAgentWorkspace, usesWorkspaceNavigation, workspaceAgentRoute, workspaceSessionRoute } from "../../services/workspace-agent-navigation.ts"
import SidebarSessionRow from "./SidebarSessionRow.vue"
import MachineBatteryIndicator from "./MachineBatteryIndicator.vue"
import TreeLink from "./TreeLink.vue"

type SessionIndicatorState = SessionActivity | "archiving"
const indicatorRank: Record<SessionIndicatorState, number> = { archiving: 4, permission: 3, question: 2, working: 1 }

const props = defineProps<{ machine: MachineSummary }>()
const { t, locale } = useI18n()
const agents = useAgentSessionsStore()
const fleet = useFleetStore()
const terminals = useTerminalsStore()
const router = useRouter()
const account = useAccountSession()
const route = useRoute()
const client = usePlatformClient()
const projectHome = computed(() => usesWorkspaceNavigation(client, !!account))
const looseSessionsOpen = ref(false)

function sessionRoute(sessionId: string, workspaceId: string | null) {
  return projectHome.value ? workspaceSessionRoute(props.machine.id, workspaceId, sessionId, account?.teamId.value) : { name: "session", params: { sessionId } }
}
function openWorkspace(workspaceId: string): void {
  openRoute(workspaceAgentRoute(props.machine.id, workspaceId, account?.teamId.value))
}
const runtimes = useMachineRuntimes()
const addingWorkspace = ref(false)
const openingTerminal = ref(false)
const terminalError = ref<{ workspaceId: string; message: string } | null>(null)
// Catalog-only entries can belong to archived Sessions; wait for their metadata.
const visibleSession = (session: AgentSessionSummary) => session.archiveState === "active" || session.archiveState === "archiving"
const sessions = useArrayFilter(() => props.machine.sessions, visibleSession)
const defaultOwner = computedAsync(async () => {
  const userId = account?.account?.value.user?.id
  if (!projectHome.value || !userId) return
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
})
const defaultSessions = computed(() => {
  if (!defaultOwner.value) return []
  const workspace = props.machine.workspaces.find(item => isPrivateAgentWorkspace(item)
    && item.directories[0]?.path.split(/[\\/]/u).filter(Boolean).at(-1) === defaultOwner.value)
  return workspace?.sessions.filter(visibleSession) ?? []
})
const newProject = computed(() => {
  const currentProject = route.name === "workspace-agent" && (!account || account.machineId.value === props.machine.id)
    ? route.params.workspaceId : undefined
  return { name: "new-project", query: { machine: props.machine.id, ...(account?.teamId.value && { team: account.teamId.value }), ...(typeof currentProject === "string" && { fromProject: currentProject }) } }
})
const workspaces = computed(() => props.machine.workspaces.filter(workspace => !projectHome.value || !isPrivateAgentWorkspace(workspace)).map(workspace => ({
  ...workspace,
  sessions: workspace.sessions.filter(visibleSession),
})))

const repeatedNames = computed(() => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  if (projectHome.value) for (const { name } of workspaces.value) {
    if (seen.has(name)) duplicates.add(name)
    seen.add(name)
  }
  return duplicates
})

function openRoute(destination: RouteLocationRaw): void {
  if (account) account.openMachineRoute(props.machine.id, destination)
  else void router.push(destination)
}

function workspaceCreated(id: string): void {
  addingWorkspace.value = false
  if (projectHome.value) openWorkspace(id)
  else startSession(id)
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

const unopened = computed(() => Boolean(runtimes && !runtimes.opened.has(props.machine.id)))
const collapsed = computed(() => unopened.value || fleet.isCollapsed(props.machine.id))
function toggleMachine(): void {
  const target = unopened.value ? account?.machines.value.find(item => item.id === props.machine.id) : undefined
  if (target && runtimes) runtimes.open(target)
  else fleet.toggleMachine(props.machine.id)
}
const lastSeen = computed(() => {
  if (!props.machine.lastSeen) return undefined
  const time = new Intl.DateTimeFormat(intlLocale(locale.value as AppLocale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(props.machine.lastSeen))
  return t("machine.lastSeen", { time })
})
const terminalLink = (terminalId: string) => ({ name: "terminal", params: { terminalId } })
const sessionIndicator = (session: { id: string; archiveState?: string }): SessionIndicatorState | false =>
  session.archiveState === "archiving" ? "archiving" : agents.isWorking(session.id)

/** Highest-priority working indicator across sessions, matching session-row precedence. */
function sessionsIndicator(items: readonly { id: string; archiveState?: string }[]): SessionIndicatorState | false {
  let best: SessionIndicatorState | false = false
  let bestRank = 0
  for (const session of items) {
    const state = sessionIndicator(session)
    if (!state) continue
    const rank = indicatorRank[state]
    if (rank <= bestRank) continue
    best = state
    bestRank = rank
    if (rank === indicatorRank.archiving) break
  }
  return best
}

const machineIndicator = computed(() => {
  if (!collapsed.value) return false
  return sessionsIndicator([
    ...sessions.value, ...defaultSessions.value,
    ...workspaces.value.flatMap(workspace => workspace.sessions),
  ])
})
</script>

<template>
  <CollapsibleRoot as="section" :data-machine-id="machine.id" :open="!collapsed" class="mt-4 first:mt-0" @update:open="toggleMachine">
    <div class="group flex h-8 items-center gap-1 pl-2.5 pr-1">
      <CollapsibleTrigger
        type="button"
        class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-[13px] font-medium text-ui-text-muted ui-motion hover:text-ui-text"
      >
        <span class="truncate">{{ machine.name }}</span>
        <span v-if="machine.local" class="inline-flex shrink-0 items-center text-ui-text-muted" :title="t('machine.local')">
          <LocateFixed :size="14" :stroke-width="1.75" aria-hidden="true" />
          <span class="sr-only">{{ t("machine.local") }}</span>
        </span>
        <span
          v-if="!machine.online"
          class="inline-flex shrink-0 items-center text-ui-warning"
          :title="lastSeen ?? t('machine.offline')"
        >
          <Unplug :size="14" :stroke-width="1.75" aria-hidden="true" />
          <span class="sr-only">{{ t("machine.offline") }}</span>
        </span>
        <MachineBatteryIndicator :machine-id="machine.id" :online="machine.online" />
        <SessionWorkingIndicator v-if="machineIndicator" :state="machineIndicator" />
        <ChevronRight v-if="collapsed" :size="14" class="shrink-0" aria-hidden="true" />
      </CollapsibleTrigger>
      <UiButton v-if="projectHome" data-new-project variant="ghost" size="icon" :title="t('superAgent.newProject')" :aria-label="t('superAgent.newProject')" :disabled="!machine.online" @click="openRoute(newProject)">
        <Plus :size="16" :stroke-width="1.75" aria-hidden="true" />
      </UiButton>
      <TreeLink v-if="projectHome" :machine-id="machine.id" :to="{ name: 'machine-control', params: { machineId: machine.id } }"
        :icon="machine.local ? SquareTerminal : MonitorPlay" :label="t(machine.local ? 'machine.localControl' : 'machine.remoteControl')" :depth="0" compact />
      <div v-if="machine.online && !projectHome" class="flex op-0 ui-motion group-hover:op-100 group-focus-within:op-100">
        <UiButton variant="ghost" size="icon" :label="t('machine.addWorkspace')" :placeholder="false" :disabled="unopened || !fleet.canManageCatalog" @click="addingWorkspace = true"><FolderPlus :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
      </div>
    </div>
    <WorkspaceCreateDialog v-if="addingWorkspace" @created="workspaceCreated" @cancel="addingWorkspace = false" />

    <CollapsibleContent as="ul" class="mt-1 flex flex-col gap-1">
      <li v-if="!projectHome">
        <TreeLink
          :machine-id="machine.id"
          :to="{ name: 'machine-control', params: { machineId: machine.id } }"
          :icon="machine.local ? SquareTerminal : MonitorPlay"
          :label="t(machine.local ? 'machine.localControl' : 'machine.remoteControl')"
          :depth="0"
        />
      </li>
      <CollapsibleRoot v-if="projectHome" v-slot="{ open }" as="li" data-default-workspace :default-open="false">
        <div class="ui-nav-item relative pr-1" :class="route.name === 'new-session' && (!account || account.machineId.value === machine.id) && 'ui-nav-active'">
          <button type="button" class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 pl-2.5 text-left" @click="openRoute(workspaceAgentRoute(machine.id, null, account?.teamId.value))">
            <Bot :size="15" class="shrink-0" aria-hidden="true" /><span class="truncate">{{ t("superAgent.defaultWorkspace") }}</span>
          </button>
          <CollapsibleTrigger v-if="defaultSessions.length" type="button" :aria-label="t('superAgent.toggleSessions', { name: t('superAgent.defaultWorkspace') })" class="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded hover:bg-ui-hover">
            <ChevronRight :size="15" :class="open && 'rotate-90'" aria-hidden="true" />
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent as="ul" class="flex flex-col gap-1 empty:hidden">
          <li v-for="session in defaultSessions" :key="session.id">
            <SidebarSessionRow :machine-id="machine.id" :session="session" :online="machine.online" :depth="1" project-worker :to="sessionRoute(session.id, null)" />
          </li>
        </CollapsibleContent>
      </CollapsibleRoot>
      <li v-if="!projectHome && workspaces.length === 0 && sessions.length === 0" class="h-8 px-2.5 leading-8 text-ui-text-faint">
        {{ t("machine.noWorkspaces") }}
      </li>
      <CollapsibleRoot v-for="workspace in workspaces" :key="workspace.id" v-slot="{ open }" as="li" :data-project-workspace="projectHome ? workspace.id : undefined" :default-open="!projectHome" class="flex flex-col gap-1">
        <WorkspaceContextMenu :workspace-id="workspace.id" :machine-id="machine.id" :name="workspace.name" :directories="workspace.directories" :disabled="!machine.online || !fleet.canManageCatalog">
          <div class="workspace-row ui-nav-item relative" :class="projectHome && route.name === 'workspace-agent' && route.params.workspaceId === workspace.id && (!account || account.machineId.value === machine.id) && 'ui-nav-active'">
            <button v-if="projectHome" type="button" data-open-project :title="workspace.directories[0]?.path" class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 pl-2.5 text-left" @click="openWorkspace(workspace.id)">
              <Bot :size="15" class="shrink-0" aria-hidden="true" />
              <span class="truncate">{{ workspace.name }}</span>
              <span v-if="repeatedNames.has(workspace.name)" class="shrink-0 pr-1 text-xs text-ui-text-muted">#{{ workspace.id }}</span>
              <SessionWorkingIndicator v-if="!open && sessionsIndicator(workspace.sessions)" :state="sessionsIndicator(workspace.sessions)" />
              <SessionUnreadIndicator v-else-if="!open && workspace.sessions.some(sessionIsUnread)" />
            </button>
            <CollapsibleTrigger v-else type="button" :aria-label="workspace.name" class="relative flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 pl-2.5 pr-1 text-left">
              <component :is="open ? FolderOpen : Folder" :size="15" :stroke-width="1.75" class="workspace-folder-icon shrink-0" aria-hidden="true" />
              <ChevronRight :size="15" :stroke-width="1.75" class="workspace-collapse-icon absolute left-2.5 shrink-0" :class="open && 'rotate-90'" aria-hidden="true" />
              <span class="truncate">{{ workspace.name }}</span>
              <SessionWorkingIndicator v-if="!open && sessionsIndicator(workspace.sessions)" :state="sessionsIndicator(workspace.sessions)" />
            </CollapsibleTrigger>
            <div class="workspace-actions flex shrink-0 items-center pr-1">
              <UiButton variant="ghost" size="icon" :label="t('workspace.openDefaultTerminal')" class="text-inherit enabled:hover:bg-transparent enabled:hover:text-inherit" :disabled="!machine.online || openingTerminal || workspace.directories.length === 0" @click="openTerminal(workspace)"><SquareTerminal :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
              <UiButton v-if="!projectHome" variant="ghost" size="icon" :label="t('workspace.newSession')" class="text-inherit enabled:hover:bg-transparent enabled:hover:text-inherit" :disabled="!machine.online" @click="startSession(workspace.id)"><SquarePen :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
            </div>
            <CollapsibleTrigger v-if="projectHome" type="button" :aria-label="t('superAgent.toggleSessions', { name: repeatedNames.has(workspace.name) ? `${workspace.name} #${workspace.id}` : workspace.name })" class="mr-1 grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded hover:bg-ui-hover">
              <ChevronRight :size="15" :class="open && 'rotate-90'" aria-hidden="true" />
            </CollapsibleTrigger>
          </div>
        </WorkspaceContextMenu>
        <p v-if="terminalError?.workspaceId === workspace.id" role="alert" class="m-0 break-words px-2.5 text-xs text-ui-danger">{{ terminalError.message }}</p>
        <CollapsibleContent as="ul" class="flex flex-col gap-1 empty:hidden">
          <li v-for="terminal in workspace.terminals" :key="terminal.id">
            <TreeLink :machine-id="machine.id" :to="terminalLink(terminal.id)" :icon="SquareTerminal" :label="terminal.title" :depth="1" />
          </li>
          <li v-for="session in workspace.sessions" :key="session.id">
            <SidebarSessionRow :machine-id="machine.id" :session="session" :online="machine.online" :depth="1" :project-worker="projectHome" :to="sessionRoute(session.id, workspace.id)" />
          </li>
        </CollapsibleContent>
      </CollapsibleRoot>
      <li v-if="projectHome && sessions.length">
        <button type="button" data-unassigned-sessions class="ui-nav-item w-full px-2.5 text-left" :aria-expanded="looseSessionsOpen" @click="looseSessionsOpen = !looseSessionsOpen">
          <ChevronRight :size="15" :class="looseSessionsOpen && 'rotate-90'" aria-hidden="true" />{{ t("superAgent.machineNav.unassigned") }}
        </button>
      </li>
      <li v-for="session in !projectHome || looseSessionsOpen ? sessions : []" :key="session.id">
        <SidebarSessionRow :machine-id="machine.id" :session="session" :online="machine.online" :depth="projectHome ? 1 : 0" :to="sessionRoute(session.id, null)" />
      </li>
    </CollapsibleContent>
  </CollapsibleRoot>
</template>

<style scoped>
.workspace-folder-icon,
.workspace-collapse-icon,
.workspace-actions {
  transition: opacity var(--ui-duration-instant) var(--ui-ease-out), transform var(--ui-duration-instant) var(--ui-ease-out);
}

.workspace-collapse-icon,
.workspace-actions {
  opacity: 0;
  pointer-events: none;
}

.workspace-row:is(:hover, :has(:focus-visible)) .workspace-folder-icon {
  opacity: 0;
}

.workspace-row:is(:hover, :has(:focus-visible)) :is(.workspace-collapse-icon, .workspace-actions) {
  opacity: 1;
  pointer-events: auto;
}

@media (hover: none) {
  [data-project-workspace] .workspace-actions {
    opacity: 1;
    pointer-events: auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .workspace-folder-icon,
  .workspace-collapse-icon,
  .workspace-actions {
    transition: none;
  }
}
</style>
