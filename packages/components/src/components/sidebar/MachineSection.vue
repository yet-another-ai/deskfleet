<script setup lang="ts">
import {
  Archive,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  MessageCircle,
  MonitorPlay,
  SquarePen,
  SquareTerminal,
} from "@lucide/vue"
import { computed, onBeforeUnmount, ref, watch, watchEffect } from "vue"
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui"
import { useI18n } from "vue-i18n"
import { useRoute, useRouter, type RouteLocationRaw } from "vue-router"
import type { AgentSessionSummary, MachineSummary, WorkspaceSummary } from "../../stores/fleet-types.ts"
import { useSessionLabel } from "../../composables/useSessionLabel.ts"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useMachineRuntimes } from "../../composables/useMachineRuntimes.ts"
import { useSidebarFilter } from "../../composables/useSidebarFilter.ts"
import { sessionOrderGroup, useSidebarOrder, workspaceOrderGroup } from "../../composables/useSidebarOrder.ts"
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
import SessionHoverTooltip from "./SessionHoverTooltip.vue"
import SessionUnreadIndicator from "./SessionUnreadIndicator.vue"
import SessionWorkingIndicator from "./SessionWorkingIndicator.vue"
import SessionPullRequestIndicators from "./SessionPullRequestIndicators.vue"
import SidebarMachineGroup from "./SidebarMachineGroup.vue"
import SidebarReorderRow from "./SidebarReorderRow.vue"
import TreeLink from "./TreeLink.vue"

type SessionIndicatorState = SessionActivity | "archiving"
const indicatorRank: Record<SessionIndicatorState, number> = { archiving: 4, permission: 3, question: 2, working: 1 }
const MAX_VISIBLE_SESSIONS = 10

const props = defineProps<{ machine: MachineSummary }>()
const { t } = useI18n()
const sessionLabel = useSessionLabel()
const agents = useAgentSessionsStore()
const fleet = useFleetStore()
const pins = usePinnedSessionsStore()
const terminals = useTerminalsStore()
const route = useRoute()
const router = useRouter()
const account = useAccountSession()
const runtimes = useMachineRuntimes()
const sidebarFilter = useSidebarFilter()
const sidebarOrder = useSidebarOrder()
const machineItems = computed(() => account?.machines?.value ?? fleet.machines)
const workspaceGroup = computed(() => workspaceOrderGroup(props.machine.id))
const sessionGroup = (workspaceId?: string) => sessionOrderGroup(props.machine.id, workspaceId)
const addingWorkspace = ref(false)
const openingTerminal = ref(false)
const terminalError = ref<{ workspaceId: string; message: string } | null>(null)
const expandedGroups = ref(new Set<string>())

const activeOnly = (items: readonly AgentSessionSummary[], workspaceId?: string) => sidebarOrder.ordered(
  sessionGroup(workspaceId),
  items.filter(s => s.archiveState === "active" || s.archiveState === "archiving").sort(compareSessionsByRecency),
)

// Catalog-only entries can belong to archived Sessions; wait for their metadata.
const activeMachineSessions = computed(() => activeOnly(props.machine.sessions))
const workspaceItems = computed(() => sidebarOrder.ordered(workspaceGroup.value, props.machine.workspaces))
const activeWorkspaces = computed(() => workspaceItems.value.map(workspace => ({
  ...workspace,
  allSessions: activeOnly(workspace.sessions, workspace.id),
})))

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

watchEffect(() => {
  let unread = 0
  let working = 0
  for (const session of [...activeMachineSessions.value, ...activeWorkspaces.value.flatMap(w => w.allSessions)]) {
    if (sessionIndicator(session)) working++
    else if (sessionIsUnread(session)) unread++
  }
  sidebarFilter.counts.set(props.machine.id, { unread, working })
})
onBeforeUnmount(() => { sidebarFilter.counts.delete(props.machine.id) })

// Pinned sessions appear solely in PinnedSessions above the tree to avoid duplicate rows and active highlights.
const unpinnedMachineSessions = computed(() => activeMachineSessions.value.filter(notPinned))
const sessions = computed(() => unpinnedMachineSessions.value.filter(matchesFilter))
const workspaces = computed(() => {
  const mapped = activeWorkspaces.value.map(workspace => {
    const unpinned = workspace.allSessions.filter(notPinned)
    return { ...workspace, unpinnedSessions: unpinned, sessions: unpinned.filter(matchesFilter) }
  })
  return filtering.value ? mapped.filter(workspace => workspace.sessions.length > 0) : mapped
})
const unopened = computed(() => Boolean(runtimes && !runtimes.opened.has(props.machine.id)))
const showMachine = computed(() => !filtering.value || unopened.value || sessions.value.length > 0 || workspaces.value.length > 0)

const selectedMachine = computed(() => !account || account.machineId.value === props.machine.id)

const activeSessionId = computed(() =>
  route.name === "session" && selectedMachine.value && typeof route.params.sessionId === "string"
    ? route.params.sessionId : undefined,
)
watch([activeSessionId, sessions, workspaces], ([id]) => {
  if (!id) return
  if (sessions.value.findIndex(s => s.id === id) >= MAX_VISIBLE_SESSIONS) expandedGroups.value.add("")
  for (const workspace of workspaces.value) {
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
  startSession(id)
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
  return sessionsIndicator([
    ...unpinnedMachineSessions.value,
    ...activeWorkspaces.value.flatMap(workspace => workspace.allSessions.filter(notPinned)),
  ])
})
</script>

<template>
  <SidebarMachineGroup v-if="showMachine" :machine="machine" :open="!collapsed" :reorder-items="machineItems" @update:open="toggleMachine">
    <template #status>
      <SessionWorkingIndicator v-if="machineIndicator" :state="machineIndicator" />
    </template>
    <template v-if="machine.online" #actions>
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
    </template>
    <template #after-header>
      <WorkspaceCreateDialog v-if="addingWorkspace" @created="workspaceCreated" @cancel="addingWorkspace = false" />
    </template>

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
      <li v-if="!filtering && workspaces.length === 0 && activeMachineSessions.length === 0" class="h-8 pl-6 pr-2.5 leading-8 text-ui-text-faint">
        {{ t("machine.noWorkspaces") }}
      </li>
      <CollapsibleRoot v-for="workspace in workspaces" :key="workspace.id" v-slot="{ open }" as="li" default-open class="flex flex-col gap-1">
        <WorkspaceContextMenu :workspace-id="workspace.id" :machine-id="machine.id" :name="workspace.name" :directories="workspace.directories" :disabled="!machine.online || !fleet.canManageCatalog">
          <SidebarReorderRow
            v-slot="{ source }"
            :group="workspaceGroup"
            :id="workspace.id"
            :items="workspaceItems"
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
  </SidebarMachineGroup>
</template>
