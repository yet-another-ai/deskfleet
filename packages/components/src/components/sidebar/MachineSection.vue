<script setup lang="ts">
import {
  Archive,
  Bot,
  ChevronRight,
  EllipsisVertical,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  FolderPlus,
  LocateFixed,
  MessageCircle,
  MonitorPlay,
  Plus,
  SquarePen,
  SquareTerminal,
  Unplug,
} from "@lucide/vue"
import { computedAsync } from "@vueuse/core"
import { computed, onBeforeUnmount, ref, watch, watchEffect } from "vue"
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui"
import { useI18n } from "vue-i18n"
import { useRoute, useRouter, type RouteLocationRaw } from "vue-router"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import type { AgentSessionSummary, MachineSummary, WorkspaceSummary } from "../../stores/fleet-types.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { useSessionLabel } from "../../composables/useSessionLabel.ts"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useHiddenWorkspaces } from "../../composables/useHiddenWorkspaces.ts"
import { useMachineRuntimes } from "../../composables/useMachineRuntimes.ts"
import { useSidebarFilter } from "../../composables/useSidebarFilter.ts"
import { machineOrderGroup, sessionOrderGroup, useSidebarOrder, workspaceOrderGroup } from "../../composables/useSidebarOrder.ts"
import { useWorkspaceAgentSummary } from "../../composables/useWorkspaceAgentSummary.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { usePinnedSessionsStore } from "../../stores/pinned-sessions.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import UiButton from "../common/UiButton.vue"
import WorkspaceCreateDialog from "../catalog/WorkspaceCreateDialog.vue"
import WorkspaceContextMenu from "../catalog/WorkspaceContextMenu.vue"
import SessionContextMenu from "../session/SessionContextMenu.vue"
import { sessionIsUnread, type SessionActivity } from "../../services/agent-conversation.ts"
import { compareSessionsByRecency } from "../../services/session-preview.ts"
import { isPrivateAgentWorkspace, usesWorkspaceNavigation, workspaceAgentRoute, workspaceSessionRoute } from "../../services/workspace-agent-navigation.ts"
import { computeMachineSidebarSummary } from "../../services/workspace-agent-sidebar.ts"
import SessionHoverTooltip from "./SessionHoverTooltip.vue"
import SessionUnreadIndicator from "./SessionUnreadIndicator.vue"
import SessionWorkingIndicator from "./SessionWorkingIndicator.vue"
import SessionPullRequestIndicators from "./SessionPullRequestIndicators.vue"
import MachineBatteryIndicator from "./MachineBatteryIndicator.vue"
import MachineContextMenu from "./MachineContextMenu.vue"
import SidebarReorderRow from "./SidebarReorderRow.vue"
import SidebarSessionRow from "./SidebarSessionRow.vue"
import TreeLink from "./TreeLink.vue"

type SessionIndicatorState = SessionActivity | "archiving"
const indicatorRank: Record<SessionIndicatorState, number> = { archiving: 4, permission: 3, question: 2, working: 1 }
const MAX_VISIBLE_SESSIONS = 10

const props = defineProps<{ machine: MachineSummary }>()
const { t, locale } = useI18n()
const sessionLabel = useSessionLabel()
const agents = useAgentSessionsStore()
const fleet = useFleetStore()
const pins = usePinnedSessionsStore()
const terminals = useTerminalsStore()
const route = useRoute()
const router = useRouter()
const account = useAccountSession()
const client = usePlatformClient()
const projectHome = computed(() => usesWorkspaceNavigation(client, !!account))
const duplicateMachine = computed(() => projectHome.value && account?.machines?.value.some(other => other.id !== props.machine.id && other.name === props.machine.name))
const looseSessionsOpen = ref(false)

function sessionRoute(sessionId: string, workspaceId: string | null) {
  return projectHome.value ? workspaceSessionRoute(props.machine.id, workspaceId, sessionId, account?.teamId.value) : { name: "session", params: { sessionId } }
}
function openWorkspace(workspaceId: string): void {
  openRoute(workspaceAgentRoute(props.machine.id, workspaceId, account?.teamId.value))
}
const runtimes = useMachineRuntimes()
const sidebarFilter = useSidebarFilter()
const sidebarOrder = useSidebarOrder()
const hiddenWorkspaces = useHiddenWorkspaces()
const saSummaryStore = useWorkspaceAgentSummary()
const defaultWorkspaceOpen = ref(false)
const projectOpenState = ref(new Map<string, boolean>())
function setProjectOpen(workspaceId: string, open: boolean): void {
  const next = new Map(projectOpenState.value)
  next.set(workspaceId, open)
  projectOpenState.value = next
}
const showingHidden = computed(() => hiddenWorkspaces.isShowingHidden(props.machine.id))
const machineItems = computed(() => account?.machines?.value ?? fleet.machines)
const workspaceGroup = computed(() => workspaceOrderGroup(props.machine.id))
const sessionGroup = (workspaceId?: string) => sessionOrderGroup(props.machine.id, workspaceId)
const addingWorkspace = ref(false)
const openingTerminal = ref(false)
const terminalError = ref<{ workspaceId: string; message: string } | null>(null)
const expandedGroups = ref(new Set<string>())

const visibleSession = (s: AgentSessionSummary) => s.archiveState === "active" || s.archiveState === "archiving"
const activeOnly = (items: readonly AgentSessionSummary[], workspaceId?: string) => sidebarOrder.ordered(
  sessionGroup(workspaceId),
  items.filter(visibleSession).sort(compareSessionsByRecency),
)

// Catalog-only entries can belong to archived Sessions; wait for their metadata.
const activeMachineSessions = computed(() => activeOnly(props.machine.sessions))
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
const workspaceItems = computed(() => sidebarOrder.ordered(
  workspaceGroup.value,
  props.machine.workspaces.filter(workspace => !projectHome.value || !isPrivateAgentWorkspace(workspace)),
))
const activeWorkspaces = computed(() => workspaceItems.value.map(workspace => ({
  ...workspace,
  allSessions: activeOnly(workspace.sessions, workspace.id),
})))
const visibleActiveWorkspaces = computed(() => activeWorkspaces.value.filter(workspace => !hiddenWorkspaces.isHidden(props.machine.id, workspace.id)))
const hiddenActiveWorkspaces = computed(() => activeWorkspaces.value.filter(workspace => hiddenWorkspaces.isHidden(props.machine.id, workspace.id)))
const sidebarActiveWorkspaces = computed(() => showingHidden.value
  ? [...visibleActiveWorkspaces.value, ...hiddenActiveWorkspaces.value]
  : visibleActiveWorkspaces.value)
const repeatedNames = computed(() => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  if (projectHome.value) for (const { name } of workspaceItems.value) {
    if (seen.has(name)) duplicates.add(name)
    seen.add(name)
  }
  return duplicates
})

const sessionIndicator = (session: { id: string; archiveState?: string }): SessionIndicatorState | false =>
  session.archiveState === "archiving" ? "archiving" : agents.isWorking(session.id)

const filtering = computed(() => sidebarFilter.filter.value !== "all")
const matchesFilter = (session: AgentSessionSummary) => {
  const mode = sidebarFilter.filter.value
  if (mode === "all") return true
  const indicator = sessionIndicator(session)
  return mode === "working" ? Boolean(indicator) : !indicator && sessionIsUnread(session)
}
const notPinned = (session: AgentSessionSummary) => !pins.isPinned(props.machine.id, session.id)

const unopened = computed(() => Boolean(runtimes && !runtimes.opened.has(props.machine.id)))

const stopSaObserver = saSummaryStore.observeMachine(
  () => props.machine.id,
  () => ({
    online: props.machine.online,
    unopened: unopened.value,
    api: unopened.value ? undefined : (runtimes?.opened.get(props.machine.id)?.api?.superAgent ?? client.superAgent),
    machine: account?.machines.value.find(item => item.id === props.machine.id),
    catalogOnChanged: unopened.value ? undefined : client.catalog.onChanged,
  }),
)
onBeforeUnmount(() => { stopSaObserver() })

const hiddenWorkspaceIds = computed(() => new Set(
  showingHidden.value ? [] : hiddenActiveWorkspaces.value.map(workspace => workspace.id),
))

const saSidebarSummary = computed(() => {
  if (!projectHome.value) return undefined
  return computeMachineSidebarSummary({
    online: props.machine.online,
    unopened: unopened.value,
    filter: sidebarFilter.filter.value,
    hiddenWorkspaceIds: hiddenWorkspaceIds.value,
    defaultSessions: defaultSessions.value,
    workspaces: sidebarActiveWorkspaces.value,
    unassignedSessions: activeMachineSessions.value,
    sessionIndicator,
    saSummary: saSummaryStore.machineState(props.machine.id),
  })
})

watchEffect(() => {
  if (!projectHome.value) {
    let unread = 0
    let working = 0
    for (const session of [...activeMachineSessions.value, ...sidebarActiveWorkspaces.value.flatMap(w => w.allSessions)]) {
      if (sessionIndicator(session)) working++
      else if (sessionIsUnread(session)) unread++
    }
    sidebarFilter.counts.set(props.machine.id, { unread, working })
    return
  }
  sidebarFilter.counts.set(props.machine.id, saSidebarSummary.value!.counts)
})
onBeforeUnmount(() => { sidebarFilter.counts.delete(props.machine.id) })

// Pinned sessions appear solely in PinnedSessions above the tree in classic mode to avoid duplicate rows.
const unpinnedMachineSessions = computed(() => activeMachineSessions.value.filter(notPinned))
const filterWorkspaces = (items: typeof activeWorkspaces.value) => {
  if (projectHome.value && saSidebarSummary.value) {
    const summaryMap = saSidebarSummary.value.workspaces
    const mapped = items.map(workspace => ({
      ...workspace,
      unpinnedSessions: workspace.allSessions,
      sessions: summaryMap.get(workspace.id)?.matchedWorkers ?? [],
    }))
    return filtering.value ? mapped.filter(workspace => summaryMap.get(workspace.id)?.visible) : mapped
  }
  const mapped = items.map(workspace => {
    const unpinned = workspace.allSessions.filter(notPinned)
    return { ...workspace, unpinnedSessions: unpinned, sessions: unpinned.filter(matchesFilter) }
  })
  return filtering.value ? mapped.filter(workspace => workspace.sessions.length > 0) : mapped
}
const sessions = computed(() => projectHome.value && saSidebarSummary.value
  ? saSidebarSummary.value.unassigned.matched
  : unpinnedMachineSessions.value.filter(matchesFilter))
const workspaces = computed(() => filterWorkspaces(visibleActiveWorkspaces.value))
const revealedHiddenWorkspaces = computed(() => showingHidden.value ? filterWorkspaces(hiddenActiveWorkspaces.value) : [])
const hasHiddenWorkspaces = computed(() => unopened.value
  ? hiddenWorkspaces.hasHidden(props.machine.id)
  : hiddenActiveWorkspaces.value.length > 0)
const showMachine = computed(() => {
  if (!filtering.value) return true
  if (!projectHome.value) return unopened.value || sessions.value.length > 0 || workspaces.value.length > 0 || revealedHiddenWorkspaces.value.length > 0
  const summary = saSidebarSummary.value!
  if (unopened.value) {
    if (summary.unknown) return true
    return sidebarFilter.filter.value === "unread" ? summary.counts.unread > 0 : summary.counts.working > 0
  }
  return summary.defaultWorkspace.visible || sessions.value.length > 0 || workspaces.value.length > 0 || revealedHiddenWorkspaces.value.length > 0
})

const defaultWorkspaceExpanded = computed(() =>
  Boolean(projectHome.value && saSidebarSummary.value?.defaultWorkspace.autoExpand) || defaultWorkspaceOpen.value,
)
const defaultWorkspaceSessions = computed(() =>
  projectHome.value && saSidebarSummary.value ? saSidebarSummary.value.defaultWorkspace.matchedWorkers : defaultSessions.value,
)
const defaultWorkspaceIndicator = computed(() => {
  const row = saSidebarSummary.value?.defaultWorkspace
  if (!row) return false
  return defaultWorkspaceExpanded.value ? row.saWorking : row.working
})
const looseSessionsExpanded = computed(() =>
  Boolean(projectHome.value && saSidebarSummary.value?.unassigned.autoExpand) || looseSessionsOpen.value,
)
function isProjectOpen(workspaceId: string): boolean {
  if (projectHome.value && saSidebarSummary.value?.workspaces.get(workspaceId)?.autoExpand) return true
  return projectOpenState.value.get(workspaceId) ?? false
}
function projectIndicator(workspaceId: string, open: boolean): SessionIndicatorState | false {
  const row = saSidebarSummary.value?.workspaces.get(workspaceId)
  if (!row) return false
  return open ? row.saWorking : row.working
}
function projectUnread(workspaceId: string): boolean {
  return saSidebarSummary.value?.workspaces.get(workspaceId)?.saUnread === true
}

watch(() => hiddenActiveWorkspaces.value.length, (count, previous) => {
  if (count === 0 && previous > 0 && showingHidden.value) hiddenWorkspaces.setShowingHidden(props.machine.id, false)
})

const selectedMachine = computed(() => !account || account.machineId.value === props.machine.id)

const activeSessionId = computed(() =>
  route.name === "session" && selectedMachine.value && typeof route.params.sessionId === "string"
    ? route.params.sessionId : undefined,
)
watch([activeSessionId, sessions, workspaces, revealedHiddenWorkspaces], ([id]) => {
  if (!id) return
  if (sessions.value.findIndex(s => s.id === id) >= MAX_VISIBLE_SESSIONS) expandedGroups.value.add("")
  for (const workspace of [...workspaces.value, ...revealedHiddenWorkspaces.value]) {
    if (workspace.sessions.findIndex(s => s.id === id) >= MAX_VISIBLE_SESSIONS) expandedGroups.value.add(workspace.id)
  }
}, { immediate: true })

const visibleOf = (key: string, items: AgentSessionSummary[]) =>
  expandedGroups.value.has(key) ? items : items.slice(0, MAX_VISIBLE_SESSIONS)
const toggleGroup = (key: string) => { if (!expandedGroups.value.delete(key)) expandedGroups.value.add(key) }

function openRoute(destination: RouteLocationRaw): void {
  if (account) account.openMachineRoute(props.machine.id, destination)
  else void router.push(destination)
}

function workspaceCreated(id: string): void {
  addingWorkspace.value = false
  if (projectHome.value) openWorkspace(id)
  else startSession(id)
}

function startSession(workspaceId: string | null): void {
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

const collapsed = computed(() => unopened.value || (!filtering.value && fleet.isCollapsed(props.machine.id)))
function toggleMachine(): void {
  const target = unopened.value ? account?.machines.value.find(item => item.id === props.machine.id) : undefined
  if (target && runtimes) runtimes.open(target)
  else fleet.toggleMachine(props.machine.id)
}
function toggleHiddenWorkspaces(): void {
  const next = !showingHidden.value
  hiddenWorkspaces.setShowingHidden(props.machine.id, next)
  if (!next) return
  if (unopened.value) {
    const target = account?.machines.value.find(item => item.id === props.machine.id)
    if (target && runtimes) runtimes.open(target)
  } else if (fleet.isCollapsed(props.machine.id)) {
    fleet.toggleMachine(props.machine.id)
  }
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
  if (projectHome.value) return saSidebarSummary.value?.machineWorking ?? false
  return sessionsIndicator([
    ...unpinnedMachineSessions.value,
    ...sidebarActiveWorkspaces.value.flatMap(workspace => workspace.allSessions.filter(notPinned)),
  ])
})
const machineHeaderUnread = computed(() => Boolean(projectHome.value && collapsed.value && saSidebarSummary.value?.machineUnread))
const machineSummaryUnknown = computed(() => Boolean(projectHome.value && saSidebarSummary.value?.unknown))
</script>

<template>
  <CollapsibleRoot
    v-if="showMachine"
    as="section"
    :data-machine-id="machine.id"
    :data-machine-summary="machineSummaryUnknown ? 'unknown' : undefined"
    :open="!collapsed"
    :class="projectHome ? 'mt-4 first:mt-0' : 'mt-2 first:mt-0'"
    @update:open="toggleMachine"
  >
    <MachineContextMenu :machine-id="machine.id" :name="machine.name" :showing-hidden="showingHidden" :has-hidden-workspaces="hasHiddenWorkspaces" @toggle-hidden="toggleHiddenWorkspaces">
      <SidebarReorderRow
        v-slot="{ source }"
        :group="machineOrderGroup"
        :id="machine.id"
        :items="machineItems"
        :class="projectHome
          ? 'group flex h-8 items-center gap-1 pl-2.5 pr-1'
          : 'group flex h-8 items-center rounded-lg pl-2.5 pr-1 ui-motion hover:bg-ui-hover'"
      >
        <CollapsibleTrigger
          v-bind="source"
          type="button"
          class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 pr-1 text-left text-[13px] font-medium text-ui-text-muted ui-motion group-hover:text-ui-text"
        >
          <span :class="projectHome ? 'truncate' : 'min-w-0 flex-1 truncate'" :title="duplicateMachine ? machine.name + ' #' + machine.id : undefined">{{ machine.name }}</span>
          <small v-if="duplicateMachine" class="shrink-0 text-xs text-ui-text-muted">#{{ machine.id }}</small>
          <span v-if="machine.local" class="inline-flex shrink-0 items-center text-ui-text-muted" :title="t('machine.local')">
            <LocateFixed :size="projectHome ? 14 : 13" :stroke-width="1.75" aria-hidden="true" />
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
          <SessionUnreadIndicator v-if="machineHeaderUnread" />
          <ChevronRight v-if="projectHome && collapsed" :size="14" class="shrink-0" aria-hidden="true" />
        </CollapsibleTrigger>
        <template v-if="projectHome">
          <UiButton
            v-if="client.mobile && (showingHidden || hasHiddenWorkspaces)"
            data-machine-toggle-hidden
            variant="ghost"
            size="icon"
            :label="t(showingHidden ? 'machine.hideHiddenWorkspaces' : 'machine.showHiddenWorkspaces')"
            :aria-pressed="showingHidden"
            @click="toggleHiddenWorkspaces"
          >
            <component :is="showingHidden ? EyeOff : Eye" :size="15" :stroke-width="1.75" aria-hidden="true" />
          </UiButton>
          <UiButton data-new-project variant="ghost" size="icon" :title="t('superAgent.newProject')" :aria-label="t('superAgent.newProject')" :disabled="!machine.online" @click="openRoute(newProject)">
            <Plus :size="16" :stroke-width="1.75" aria-hidden="true" />
          </UiButton>
          <TreeLink :machine-id="machine.id" :to="{ name: 'machine-control', params: { machineId: machine.id } }"
            :icon="machine.local ? SquareTerminal : MonitorPlay" :label="t(machine.local ? 'machine.localControl' : 'machine.remoteControl')" :depth="0" compact />
        </template>
        <div v-else class="flex shrink-0 items-center gap-0.5">
          <UiButton
            v-if="client.mobile && (showingHidden || hasHiddenWorkspaces)"
            data-machine-toggle-hidden
            variant="ghost"
            size="icon"
            class="!h-6 !w-6 rounded-md text-ui-text-faint [&:not(:disabled,[aria-disabled=true])]:hover:bg-ui-text/8 [&:not(:disabled,[aria-disabled=true])]:hover:text-ui-text"
            :label="t(showingHidden ? 'machine.hideHiddenWorkspaces' : 'machine.showHiddenWorkspaces')"
            :aria-pressed="showingHidden"
            @click="toggleHiddenWorkspaces"
          >
            <component :is="showingHidden ? EyeOff : Eye" :size="14" :stroke-width="1.75" aria-hidden="true" />
          </UiButton>
          <div
            v-if="machine.online"
            class="flex shrink-0 items-center text-ui-text-faint ui-motion can-hover:max-w-0 can-hover:overflow-hidden can-hover:op-0 can-hover:pointer-events-none group-hover:max-w-8 group-hover:op-100 group-hover:pointer-events-auto group-has-[:focus-visible]:max-w-8 group-has-[:focus-visible]:op-100 group-has-[:focus-visible]:pointer-events-auto"
          >
            <UiButton
              variant="ghost"
              size="icon"
              class="!h-6 !w-6 rounded-md text-current [&:not(:disabled,[aria-disabled=true])]:hover:bg-ui-text/8 [&:not(:disabled,[aria-disabled=true])]:hover:text-ui-text"
              :label="t('machine.addWorkspace')"
              :placeholder="false"
              :disabled="unopened || !fleet.canManageCatalog"
              @click="addingWorkspace = true"
            >
              <FolderPlus :size="14" :stroke-width="1.75" aria-hidden="true" />
            </UiButton>
          </div>
          <CollapsibleTrigger
            type="button"
            tabindex="-1"
            aria-hidden="true"
            class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-ui-text-faint ui-motion hover:bg-ui-text/8 hover:text-ui-text"
          >
            <ChevronRight :size="14" :stroke-width="1.75" class="ui-motion" :class="!collapsed && 'rotate-90'" aria-hidden="true" />
          </CollapsibleTrigger>
        </div>
      </SidebarReorderRow>
    </MachineContextMenu>
    <WorkspaceCreateDialog v-if="addingWorkspace" @created="workspaceCreated" @cancel="addingWorkspace = false" />

    <CollapsibleContent as="ul" class="m-0 mt-1 flex list-none flex-col gap-1 p-0">
      <template v-if="projectHome">
        <CollapsibleRoot v-if="!filtering || saSidebarSummary?.defaultWorkspace.visible" :open="defaultWorkspaceExpanded" as="li" data-default-workspace @update:open="value => (defaultWorkspaceOpen = value)">
          <div class="ui-nav-item relative pr-1" :class="route.name === 'new-session' && (!account || account.machineId.value === machine.id) && 'ui-nav-active'">
            <button type="button" data-open-default-workspace class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 pl-2.5 text-left" @click="openRoute(workspaceAgentRoute(machine.id, null, account?.teamId.value))">
              <Bot :size="15" class="shrink-0" aria-hidden="true" /><span class="truncate">{{ t("superAgent.defaultWorkspace") }}</span>
              <SessionWorkingIndicator v-if="defaultWorkspaceIndicator" :state="defaultWorkspaceIndicator" />
              <SessionUnreadIndicator v-else-if="saSidebarSummary?.defaultWorkspace.saUnread" />
            </button>
            <CollapsibleTrigger v-if="defaultWorkspaceSessions.length" type="button" :aria-label="t('superAgent.toggleSessions', { name: t('superAgent.defaultWorkspace') })" class="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded hover:bg-ui-hover">
              <ChevronRight :size="15" :class="defaultWorkspaceExpanded && 'rotate-90'" aria-hidden="true" />
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent as="ul" class="flex flex-col gap-1 empty:hidden">
            <li v-for="session in defaultWorkspaceSessions" :key="session.id">
              <SidebarSessionRow
                :machine-id="machine.id"
                :session="session"
                :online="machine.online"
                :depth="1"
                project-worker
                :unread-override="saSidebarSummary?.workerUnreadById.get(session.id)"
                :working-override="saSidebarSummary?.workerWorkingById.get(session.id)"
                :to="sessionRoute(session.id, null)"
              />
            </li>
          </CollapsibleContent>
        </CollapsibleRoot>
        <CollapsibleRoot v-for="workspace in workspaces" :key="workspace.id" :open="isProjectOpen(workspace.id)" as="li" :data-project-workspace="workspace.id" class="flex flex-col gap-1" @update:open="value => setProjectOpen(workspace.id, value)">
          <WorkspaceContextMenu v-slot="{ openActions }" :workspace-id="workspace.id" :machine-id="machine.id" :name="workspace.name" :directories="workspace.directories" :disabled="!machine.online || !fleet.canManageCatalog">
            <div class="workspace-row ui-nav-item relative" :class="route.name === 'workspace-agent' && route.params.workspaceId === workspace.id && (!account || account.machineId.value === machine.id) && 'ui-nav-active'">
              <button type="button" data-open-project :title="workspace.directories[0]?.path" class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 pl-2.5 text-left" @click="openWorkspace(workspace.id)">
                <Bot :size="15" class="shrink-0" aria-hidden="true" />
                <span class="truncate">{{ workspace.name }}</span>
                <span v-if="repeatedNames.has(workspace.name)" class="shrink-0 pr-1 text-xs text-ui-text-muted">#{{ workspace.id }}</span>
                <SessionWorkingIndicator v-if="projectIndicator(workspace.id, isProjectOpen(workspace.id))" :state="projectIndicator(workspace.id, isProjectOpen(workspace.id))" />
                <SessionUnreadIndicator v-else-if="projectUnread(workspace.id)" />
              </button>
              <div class="workspace-actions flex shrink-0 items-center pr-1">
                <UiButton variant="ghost" size="icon" :label="t('workspace.openDefaultTerminal')" class="text-inherit enabled:hover:bg-transparent enabled:hover:text-inherit" :disabled="!machine.online || openingTerminal || workspace.directories.length === 0" @click="openTerminal(workspace)"><SquareTerminal :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
                <UiButton v-if="client.mobile" data-workspace-menu-trigger variant="ghost" size="icon" :label="t('workspace.actions')" class="text-inherit enabled:hover:bg-transparent enabled:hover:text-inherit" @click.stop="openActions($event)"><EllipsisVertical :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
              </div>
              <CollapsibleTrigger type="button" :aria-label="t('superAgent.toggleSessions', { name: repeatedNames.has(workspace.name) ? `${workspace.name} #${workspace.id}` : workspace.name })" class="mr-1 grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded hover:bg-ui-hover">
                <ChevronRight :size="15" :class="isProjectOpen(workspace.id) && 'rotate-90'" aria-hidden="true" />
              </CollapsibleTrigger>
            </div>
          </WorkspaceContextMenu>
          <p v-if="terminalError?.workspaceId === workspace.id" role="alert" class="m-0 break-words px-2.5 text-xs text-ui-danger">{{ terminalError.message }}</p>
          <CollapsibleContent as="ul" class="flex flex-col gap-1 empty:hidden">
            <template v-if="!filtering">
              <li v-for="terminal in workspace.terminals" :key="terminal.id">
                <TreeLink :machine-id="machine.id" :to="terminalLink(terminal.id)" :icon="SquareTerminal" :label="terminal.title" :depth="1" />
              </li>
            </template>
            <li v-for="session in workspace.sessions" :key="session.id">
              <SidebarSessionRow
                :machine-id="machine.id"
                :session="session"
                :online="machine.online"
                :depth="1"
                project-worker
                :unread-override="saSidebarSummary?.workerUnreadById.get(session.id)"
                :working-override="saSidebarSummary?.workerWorkingById.get(session.id)"
                :to="sessionRoute(session.id, workspace.id)"
              />
            </li>
          </CollapsibleContent>
        </CollapsibleRoot>
        <li v-if="revealedHiddenWorkspaces.length" data-hidden-workspaces-header class="mt-1.5 flex items-center gap-1.5 px-2.5 pt-1 text-[11px] font-medium text-ui-text-faint">
          <EyeOff :size="12" aria-hidden="true" />
          <span>{{ t("workspace.hiddenSection") }}</span>
        </li>
        <CollapsibleRoot v-for="workspace in revealedHiddenWorkspaces" :key="workspace.id" :open="isProjectOpen(workspace.id)" as="li" :data-project-workspace="workspace.id" data-workspace-hidden="true" class="flex flex-col gap-1" @update:open="value => setProjectOpen(workspace.id, value)">
          <WorkspaceContextMenu v-slot="{ openActions }" :workspace-id="workspace.id" :machine-id="machine.id" :name="workspace.name" :directories="workspace.directories" :disabled="!machine.online || !fleet.canManageCatalog">
            <div class="workspace-row ui-nav-item relative border border-dashed border-ui-border-strong/70 opacity-75 hover:opacity-100" :class="route.name === 'workspace-agent' && route.params.workspaceId === workspace.id && (!account || account.machineId.value === machine.id) && 'ui-nav-active opacity-100'">
              <button type="button" data-open-project :title="workspace.directories[0]?.path" class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 pl-2.5 text-left text-ui-text-muted" @click="openWorkspace(workspace.id)">
                <EyeOff :size="15" class="shrink-0 text-ui-text-faint" aria-hidden="true" />
                <span class="truncate">{{ workspace.name }}</span>
                <span v-if="repeatedNames.has(workspace.name)" class="shrink-0 pr-1 text-xs text-ui-text-muted">#{{ workspace.id }}</span>
                <span data-workspace-hidden-badge class="ui-badge shrink-0">{{ t("workspace.hiddenBadge") }}</span>
                <SessionWorkingIndicator v-if="projectIndicator(workspace.id, isProjectOpen(workspace.id))" :state="projectIndicator(workspace.id, isProjectOpen(workspace.id))" />
                <SessionUnreadIndicator v-else-if="projectUnread(workspace.id)" />
              </button>
              <div class="workspace-actions flex shrink-0 items-center pr-1">
                <UiButton variant="ghost" size="icon" :label="t('workspace.openDefaultTerminal')" class="text-inherit enabled:hover:bg-transparent enabled:hover:text-inherit" :disabled="!machine.online || openingTerminal || workspace.directories.length === 0" @click="openTerminal(workspace)"><SquareTerminal :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
                <UiButton v-if="client.mobile" data-workspace-menu-trigger variant="ghost" size="icon" :label="t('workspace.actions')" class="text-inherit enabled:hover:bg-transparent enabled:hover:text-inherit" @click.stop="openActions($event)"><EllipsisVertical :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
              </div>
              <CollapsibleTrigger type="button" :aria-label="t('superAgent.toggleSessions', { name: repeatedNames.has(workspace.name) ? `${workspace.name} #${workspace.id}` : workspace.name })" class="mr-1 grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded hover:bg-ui-hover">
                <ChevronRight :size="15" :class="isProjectOpen(workspace.id) && 'rotate-90'" aria-hidden="true" />
              </CollapsibleTrigger>
            </div>
          </WorkspaceContextMenu>
          <p v-if="terminalError?.workspaceId === workspace.id" role="alert" class="m-0 break-words px-2.5 text-xs text-ui-danger">{{ terminalError.message }}</p>
          <CollapsibleContent as="ul" class="flex flex-col gap-1 empty:hidden">
            <template v-if="!filtering">
              <li v-for="terminal in workspace.terminals" :key="terminal.id">
                <TreeLink :machine-id="machine.id" :to="terminalLink(terminal.id)" :icon="SquareTerminal" :label="terminal.title" :depth="1" />
              </li>
            </template>
            <li v-for="session in workspace.sessions" :key="session.id">
              <SidebarSessionRow
                :machine-id="machine.id"
                :session="session"
                :online="machine.online"
                :depth="1"
                project-worker
                :unread-override="saSidebarSummary?.workerUnreadById.get(session.id)"
                :working-override="saSidebarSummary?.workerWorkingById.get(session.id)"
                :to="sessionRoute(session.id, workspace.id)"
              />
            </li>
          </CollapsibleContent>
        </CollapsibleRoot>
        <li v-if="sessions.length">
          <button type="button" data-unassigned-sessions class="ui-nav-item w-full px-2.5 text-left" :aria-expanded="looseSessionsExpanded" @click="looseSessionsOpen = !looseSessionsOpen">
            <ChevronRight :size="15" :class="looseSessionsExpanded && 'rotate-90'" aria-hidden="true" />{{ t("superAgent.machineNav.unassigned") }}
          </button>
        </li>
        <li v-for="session in looseSessionsExpanded ? sessions : []" :key="session.id">
          <SidebarSessionRow
            :machine-id="machine.id"
            :session="session"
            :online="machine.online"
            :depth="1"
            :unread-override="saSidebarSummary?.workerUnreadById.get(session.id)"
            :working-override="saSidebarSummary?.workerWorkingById.get(session.id)"
            :to="sessionRoute(session.id, null)"
          />
        </li>
      </template>
      <template v-else>
      <li v-if="!filtering">
        <TreeLink
          :machine-id="machine.id"
          :to="{ name: 'machine-control', params: { machineId: machine.id } }"
          :icon="machine.local ? SquareTerminal : MonitorPlay"
          :label="t(machine.local ? 'machine.localControl' : 'machine.remoteControl')"
          :depth="1"
        />
      </li>
      <CollapsibleRoot v-if="sessions.length > 0" v-slot="{ open }" as="li" default-open class="flex flex-col gap-1">
        <div class="group/chat flex h-8 items-center rounded-lg pl-4 pr-1 ui-motion hover:bg-ui-hover">
          <CollapsibleTrigger
            type="button"
            :aria-label="t('sidebar.chat')"
            class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 pr-1 text-left text-[13px] text-ui-text ui-motion"
          >
            <MessageCircle :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate">{{ t("sidebar.chat") }}</span>
            <SessionWorkingIndicator v-if="!open && sessionsIndicator(sessions)" :state="sessionsIndicator(sessions)" />
          </CollapsibleTrigger>
          <div class="flex shrink-0 items-center gap-0.5">
            <div
              class="flex shrink-0 items-center gap-0.5 text-ui-text-faint ui-motion can-hover:max-w-0 can-hover:overflow-hidden can-hover:op-0 can-hover:pointer-events-none group-hover/chat:max-w-7 group-hover/chat:op-100 group-hover/chat:pointer-events-auto group-has-[:focus-visible]/chat:max-w-7 group-has-[:focus-visible]/chat:op-100 group-has-[:focus-visible]/chat:pointer-events-auto"
            >
              <UiButton
                variant="ghost"
                size="icon"
                :label="t('workspace.newSession')"
                class="!h-6 !w-6 rounded-md text-current [&:not(:disabled,[aria-disabled=true])]:hover:bg-ui-text/8 [&:not(:disabled,[aria-disabled=true])]:hover:text-ui-text"
                :disabled="!machine.online"
                @click="startSession(null)"
              >
                <SquarePen :size="14" :stroke-width="1.75" aria-hidden="true" />
              </UiButton>
            </div>
            <CollapsibleTrigger
              type="button"
              tabindex="-1"
              aria-hidden="true"
              class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-ui-text-faint ui-motion hover:bg-ui-text/8 hover:text-ui-text"
            >
              <ChevronRight :size="14" :stroke-width="1.75" class="ui-motion" :class="open && 'rotate-90'" aria-hidden="true" />
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent as="ul" class="m-0 flex list-none flex-col gap-1 p-0 empty:hidden">
          <SidebarReorderRow v-for="session in visibleOf('', sessions)" :key="session.id" v-slot="{ source }" as="li" :group="sessionGroup()" :id="session.id" :items="unpinnedMachineSessions">
            <SessionContextMenu v-slot="{ requestArchive, pending }" :machine-id="machine.id" :session-id="session.id" :title="session.title ?? ''" :context="session.context" :archive-state="session.archiveState" :disabled="!machine.online">
              <SessionHoverTooltip :machine-id="machine.id" :session-id="session.id" :title="sessionLabel(session)" :machine-name="machine.name" :online="machine.online" :context="session.context">
                <TreeLink :machine-id="machine.id" :to="{ name: 'session', params: { sessionId: session.id } }" :label="sessionLabel(session)" :depth="2" :drag-source="source">
                  <template #trailing>
                    <SessionPullRequestIndicators :machine-id="machine.id" :session-id="session.id" />
                    <SessionWorkingIndicator v-if="sessionIndicator(session)" :state="sessionIndicator(session)" />
                    <SessionUnreadIndicator v-else-if="sessionIsUnread(session)" />
                  </template>
                  <template v-if="session.archiveState === 'active' || session.archiveState === 'archiving'" #actions>
                    <UiButton
                      variant="ghost"
                      size="icon"
                      class="!h-6 !w-6 rounded-md text-current [&:not(:disabled,[aria-disabled=true])]:hover:bg-ui-text/8 [&:not(:disabled,[aria-disabled=true])]:hover:text-ui-text [&:not(:disabled,[aria-disabled=true])]:active:bg-ui-text/14"
                      :label="t(session.archiveState === 'archiving' ? 'agent.retryArchive' : 'agent.archive')"
                      :disabled="!machine.online || pending || !session.context"
                      @click="requestArchive()"
                    >
                      <Archive :size="14" :stroke-width="1.75" aria-hidden="true" />
                    </UiButton>
                  </template>
                </TreeLink>
              </SessionHoverTooltip>
            </SessionContextMenu>
          </SidebarReorderRow>
          <li v-if="sessions.length > MAX_VISIBLE_SESSIONS">
            <button type="button" class="ui-nav-item w-full pl-[41px] pr-2.5 text-left text-xs text-ui-text-faint hover:text-ui-text" @click="toggleGroup('')">
              {{ expandedGroups.has('') ? t('sidebar.showFewerSessions') : t('sidebar.showMoreSessions', { count: sessions.length - MAX_VISIBLE_SESSIONS }) }}
            </button>
          </li>
        </CollapsibleContent>
      </CollapsibleRoot>
      <li v-if="!filtering && activeWorkspaces.length === 0 && activeMachineSessions.length === 0" class="h-8 pl-6 pr-2.5 leading-8 text-ui-text-faint">
        {{ t("machine.noWorkspaces") }}
      </li>
      <CollapsibleRoot v-for="workspace in workspaces" :key="workspace.id" v-slot="{ open }" as="li" :data-workspace-id="workspace.id" default-open class="flex flex-col gap-1">
        <WorkspaceContextMenu v-slot="{ openActions }" :workspace-id="workspace.id" :machine-id="machine.id" :name="workspace.name" :directories="workspace.directories" :disabled="!machine.online || !fleet.canManageCatalog">
          <SidebarReorderRow
            v-slot="{ source }"
            :group="workspaceGroup"
            :id="workspace.id"
            :items="visibleActiveWorkspaces"
            class="workspace-row group/ws flex h-8 items-center rounded-lg pl-4 pr-1 ui-motion hover:bg-ui-hover"
          >
            <CollapsibleTrigger
              v-bind="source"
              type="button"
              :aria-label="workspace.name"
              class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 pr-1 text-left text-[13px] text-ui-text ui-motion"
            >
              <component :is="open ? FolderOpen : Folder" :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate">{{ workspace.name }}</span>
              <SessionWorkingIndicator v-if="!open && sessionsIndicator(workspace.sessions)" :state="sessionsIndicator(workspace.sessions)" />
            </CollapsibleTrigger>
            <div class="flex shrink-0 items-center gap-0.5">
              <div
                class="flex shrink-0 items-center gap-0.5 text-ui-text-faint ui-motion can-hover:max-w-0 can-hover:overflow-hidden can-hover:op-0 can-hover:pointer-events-none group-hover/ws:max-w-14 group-hover/ws:op-100 group-hover/ws:pointer-events-auto group-has-[:focus-visible]/ws:max-w-14 group-has-[:focus-visible]/ws:op-100 group-has-[:focus-visible]/ws:pointer-events-auto"
              >
                <UiButton
                  variant="ghost"
                  size="icon"
                  :label="t('workspace.openDefaultTerminal')"
                  class="!h-6 !w-6 rounded-md text-current [&:not(:disabled,[aria-disabled=true])]:hover:bg-ui-text/8 [&:not(:disabled,[aria-disabled=true])]:hover:text-ui-text"
                  :disabled="!machine.online || openingTerminal || workspace.directories.length === 0"
                  @click="openTerminal(workspace)"
                >
                  <SquareTerminal :size="14" :stroke-width="1.75" aria-hidden="true" />
                </UiButton>
                <UiButton
                  variant="ghost"
                  size="icon"
                  :label="t('workspace.newSession')"
                  class="!h-6 !w-6 rounded-md text-current [&:not(:disabled,[aria-disabled=true])]:hover:bg-ui-text/8 [&:not(:disabled,[aria-disabled=true])]:hover:text-ui-text"
                  :disabled="!machine.online"
                  @click="startSession(workspace.id)"
                >
                  <SquarePen :size="14" :stroke-width="1.75" aria-hidden="true" />
                </UiButton>
                <UiButton
                  v-if="client.mobile"
                  data-workspace-menu-trigger
                  variant="ghost"
                  size="icon"
                  :label="t('workspace.actions')"
                  class="!h-6 !w-6 rounded-md text-current [&:not(:disabled,[aria-disabled=true])]:hover:bg-ui-text/8 [&:not(:disabled,[aria-disabled=true])]:hover:text-ui-text"
                  @click.stop="openActions($event)"
                >
                  <EllipsisVertical :size="14" :stroke-width="1.75" aria-hidden="true" />
                </UiButton>
              </div>
              <CollapsibleTrigger
                type="button"
                tabindex="-1"
                aria-hidden="true"
                class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-ui-text-faint ui-motion hover:bg-ui-text/8 hover:text-ui-text"
              >
                <ChevronRight :size="14" :stroke-width="1.75" class="ui-motion" :class="open && 'rotate-90'" aria-hidden="true" />
              </CollapsibleTrigger>
            </div>
          </SidebarReorderRow>
        </WorkspaceContextMenu>
        <p v-if="terminalError?.workspaceId === workspace.id" role="alert" class="m-0 break-words px-2.5 text-xs text-ui-danger">{{ terminalError.message }}</p>
        <CollapsibleContent as="ul" class="m-0 flex list-none flex-col gap-1 p-0 empty:hidden">
          <template v-if="!filtering">
            <li v-for="terminal in workspace.terminals" :key="terminal.id">
              <TreeLink :machine-id="machine.id" :to="terminalLink(terminal.id)" :icon="SquareTerminal" :label="terminal.title" :depth="2" />
            </li>
          </template>
          <SidebarReorderRow v-for="session in visibleOf(workspace.id, workspace.sessions)" :key="session.id" v-slot="{ source }" as="li" :group="sessionGroup(workspace.id)" :id="session.id" :items="workspace.unpinnedSessions">
            <SessionContextMenu v-slot="{ requestArchive, pending }" :machine-id="machine.id" :session-id="session.id" :title="session.title ?? ''" :context="session.context" :archive-state="session.archiveState" :disabled="!machine.online">
              <!-- A Session's shells open in its bottom panel, not the sidebar. -->
              <SessionHoverTooltip :machine-id="machine.id" :session-id="session.id" :title="sessionLabel(session)" :machine-name="machine.name" :online="machine.online" :context="session.context">
                <TreeLink :machine-id="machine.id" :to="{ name: 'session', params: { sessionId: session.id } }" :label="sessionLabel(session)" :depth="2" :drag-source="source">
                  <template #trailing>
                    <SessionPullRequestIndicators :machine-id="machine.id" :session-id="session.id" />
                    <SessionWorkingIndicator v-if="sessionIndicator(session)" :state="sessionIndicator(session)" />
                    <SessionUnreadIndicator v-else-if="sessionIsUnread(session)" />
                  </template>
                  <template v-if="session.archiveState === 'active' || session.archiveState === 'archiving'" #actions>
                    <UiButton
                      variant="ghost"
                      size="icon"
                      class="!h-6 !w-6 rounded-md text-current [&:not(:disabled,[aria-disabled=true])]:hover:bg-ui-text/8 [&:not(:disabled,[aria-disabled=true])]:hover:text-ui-text [&:not(:disabled,[aria-disabled=true])]:active:bg-ui-text/14"
                      :label="t(session.archiveState === 'archiving' ? 'agent.retryArchive' : 'agent.archive')"
                      :disabled="!machine.online || pending || !session.context"
                      @click="requestArchive()"
                    >
                      <Archive :size="14" :stroke-width="1.75" aria-hidden="true" />
                    </UiButton>
                  </template>
                </TreeLink>
              </SessionHoverTooltip>
            </SessionContextMenu>
          </SidebarReorderRow>
          <li v-if="workspace.sessions.length > MAX_VISIBLE_SESSIONS">
            <button type="button" class="ui-nav-item w-full pl-[41px] pr-2.5 text-left text-xs text-ui-text-faint hover:text-ui-text" @click="toggleGroup(workspace.id)">
              {{ expandedGroups.has(workspace.id) ? t('sidebar.showFewerSessions') : t('sidebar.showMoreSessions', { count: workspace.sessions.length - MAX_VISIBLE_SESSIONS }) }}
            </button>
          </li>
        </CollapsibleContent>
      </CollapsibleRoot>
      <li v-if="revealedHiddenWorkspaces.length" data-hidden-workspaces-header class="mt-1.5 flex items-center gap-1.5 pl-4 pr-2.5 pt-1 text-[11px] font-medium text-ui-text-faint">
        <EyeOff :size="12" aria-hidden="true" />
        <span>{{ t("workspace.hiddenSection") }}</span>
      </li>
      <CollapsibleRoot v-for="workspace in revealedHiddenWorkspaces" :key="workspace.id" v-slot="{ open }" as="li" :data-workspace-id="workspace.id" data-workspace-hidden="true" :default-open="false" class="flex flex-col gap-1">
        <WorkspaceContextMenu v-slot="{ openActions }" :workspace-id="workspace.id" :machine-id="machine.id" :name="workspace.name" :directories="workspace.directories" :disabled="!machine.online || !fleet.canManageCatalog">
          <div class="workspace-row group/ws flex h-8 items-center rounded-lg border border-dashed border-ui-border-strong/70 pl-4 pr-1 opacity-75 ui-motion hover:bg-ui-hover hover:opacity-100">
            <CollapsibleTrigger
              type="button"
              :aria-label="workspace.name"
              class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 pr-1 text-left text-[13px] text-ui-text-muted ui-motion"
            >
              <EyeOff :size="15" :stroke-width="1.75" class="shrink-0 text-ui-text-faint" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate">{{ workspace.name }}</span>
              <span data-workspace-hidden-badge class="ui-badge shrink-0">{{ t("workspace.hiddenBadge") }}</span>
              <SessionWorkingIndicator v-if="!open && sessionsIndicator(workspace.sessions)" :state="sessionsIndicator(workspace.sessions)" />
            </CollapsibleTrigger>
            <div class="flex shrink-0 items-center gap-0.5">
              <div
                class="flex shrink-0 items-center gap-0.5 text-ui-text-faint ui-motion can-hover:max-w-0 can-hover:overflow-hidden can-hover:op-0 can-hover:pointer-events-none group-hover/ws:max-w-14 group-hover/ws:op-100 group-hover/ws:pointer-events-auto group-has-[:focus-visible]/ws:max-w-14 group-has-[:focus-visible]/ws:op-100 group-has-[:focus-visible]/ws:pointer-events-auto"
              >
                <UiButton
                  variant="ghost"
                  size="icon"
                  :label="t('workspace.openDefaultTerminal')"
                  class="!h-6 !w-6 rounded-md text-current [&:not(:disabled,[aria-disabled=true])]:hover:bg-ui-text/8 [&:not(:disabled,[aria-disabled=true])]:hover:text-ui-text"
                  :disabled="!machine.online || openingTerminal || workspace.directories.length === 0"
                  @click="openTerminal(workspace)"
                >
                  <SquareTerminal :size="14" :stroke-width="1.75" aria-hidden="true" />
                </UiButton>
                <UiButton
                  variant="ghost"
                  size="icon"
                  :label="t('workspace.newSession')"
                  class="!h-6 !w-6 rounded-md text-current [&:not(:disabled,[aria-disabled=true])]:hover:bg-ui-text/8 [&:not(:disabled,[aria-disabled=true])]:hover:text-ui-text"
                  :disabled="!machine.online"
                  @click="startSession(workspace.id)"
                >
                  <SquarePen :size="14" :stroke-width="1.75" aria-hidden="true" />
                </UiButton>
                <UiButton
                  v-if="client.mobile"
                  data-workspace-menu-trigger
                  variant="ghost"
                  size="icon"
                  :label="t('workspace.actions')"
                  class="!h-6 !w-6 rounded-md text-current [&:not(:disabled,[aria-disabled=true])]:hover:bg-ui-text/8 [&:not(:disabled,[aria-disabled=true])]:hover:text-ui-text"
                  @click.stop="openActions($event)"
                >
                  <EllipsisVertical :size="14" :stroke-width="1.75" aria-hidden="true" />
                </UiButton>
              </div>
              <CollapsibleTrigger
                type="button"
                tabindex="-1"
                aria-hidden="true"
                class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-ui-text-faint ui-motion hover:bg-ui-text/8 hover:text-ui-text"
              >
                <ChevronRight :size="14" :stroke-width="1.75" class="ui-motion" :class="open && 'rotate-90'" aria-hidden="true" />
              </CollapsibleTrigger>
            </div>
          </div>
        </WorkspaceContextMenu>
        <p v-if="terminalError?.workspaceId === workspace.id" role="alert" class="m-0 break-words px-2.5 text-xs text-ui-danger">{{ terminalError.message }}</p>
        <CollapsibleContent as="ul" class="m-0 flex list-none flex-col gap-1 p-0 empty:hidden">
          <template v-if="!filtering">
            <li v-for="terminal in workspace.terminals" :key="terminal.id">
              <TreeLink :machine-id="machine.id" :to="terminalLink(terminal.id)" :icon="SquareTerminal" :label="terminal.title" :depth="2" />
            </li>
          </template>
          <SidebarReorderRow v-for="session in visibleOf(workspace.id, workspace.sessions)" :key="session.id" v-slot="{ source }" as="li" :group="sessionGroup(workspace.id)" :id="session.id" :items="workspace.unpinnedSessions">
            <SessionContextMenu v-slot="{ requestArchive, pending }" :machine-id="machine.id" :session-id="session.id" :title="session.title ?? ''" :context="session.context" :archive-state="session.archiveState" :disabled="!machine.online">
              <SessionHoverTooltip :machine-id="machine.id" :session-id="session.id" :title="sessionLabel(session)" :machine-name="machine.name" :online="machine.online" :context="session.context">
                <TreeLink :machine-id="machine.id" :to="{ name: 'session', params: { sessionId: session.id } }" :label="sessionLabel(session)" :depth="2" :drag-source="source">
                  <template #trailing>
                    <SessionPullRequestIndicators :machine-id="machine.id" :session-id="session.id" />
                    <SessionWorkingIndicator v-if="sessionIndicator(session)" :state="sessionIndicator(session)" />
                    <SessionUnreadIndicator v-else-if="sessionIsUnread(session)" />
                  </template>
                  <template v-if="session.archiveState === 'active' || session.archiveState === 'archiving'" #actions>
                    <UiButton
                      variant="ghost"
                      size="icon"
                      class="!h-6 !w-6 rounded-md text-current [&:not(:disabled,[aria-disabled=true])]:hover:bg-ui-text/8 [&:not(:disabled,[aria-disabled=true])]:hover:text-ui-text [&:not(:disabled,[aria-disabled=true])]:active:bg-ui-text/14"
                      :label="t(session.archiveState === 'archiving' ? 'agent.retryArchive' : 'agent.archive')"
                      :disabled="!machine.online || pending || !session.context"
                      @click="requestArchive()"
                    >
                      <Archive :size="14" :stroke-width="1.75" aria-hidden="true" />
                    </UiButton>
                  </template>
                </TreeLink>
              </SessionHoverTooltip>
            </SessionContextMenu>
          </SidebarReorderRow>
          <li v-if="workspace.sessions.length > MAX_VISIBLE_SESSIONS">
            <button type="button" class="ui-nav-item w-full pl-[41px] pr-2.5 text-left text-xs text-ui-text-faint hover:text-ui-text" @click="toggleGroup(workspace.id)">
              {{ expandedGroups.has(workspace.id) ? t('sidebar.showFewerSessions') : t('sidebar.showMoreSessions', { count: workspace.sessions.length - MAX_VISIBLE_SESSIONS }) }}
            </button>
          </li>
        </CollapsibleContent>
      </CollapsibleRoot>
      </template>
    </CollapsibleContent>
  </CollapsibleRoot>
</template>

<style scoped>
[data-project-workspace] .workspace-actions {
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--ui-duration-instant) var(--ui-ease-out), transform var(--ui-duration-instant) var(--ui-ease-out);
}

[data-project-workspace] .workspace-row:is(:hover, :has(:focus-visible)) .workspace-actions {
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
  [data-project-workspace] .workspace-actions {
    transition: none;
  }
}
</style>
