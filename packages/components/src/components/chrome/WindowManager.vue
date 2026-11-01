<script setup lang="ts">
import { StorageSerializers, useLocalStorage, useTimeoutFn, watchArray } from "@vueuse/core"
import { computed, onScopeDispose, shallowRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import {
  type DockviewApi,
  type DockviewGroupPanel,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type SerializedDockview,
} from "dockview-vue"
import { useRouteWorktree } from "../../composables/useRouteWorktree.ts"
import { useSessionLabel } from "../../composables/useSessionLabel.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import WindowTabBar from "./WindowTabBar.vue"
import { windowHeaderActionsTarget } from "./windowHeaderActions.ts"

type WorkspaceWindowId = "changes" | "terminal"

const props = defineProps<{ sessionId: string }>()
const { t } = useI18n()
const fleet = useFleetStore()
const layout = useLayoutStore()
const terminals = useTerminalsStore()
const routeWorktree = useRouteWorktree()
const sessionLabel = useSessionLabel()
const stored = useLocalStorage<SerializedDockview | null>(() => `deskfleet.window-layout-v4:${props.sessionId}`, null, {
  serializer: StorageSerializers.object,
})
const api = shallowRef<DockviewApi>()
const topLeftGroupId = shallowRef<string>()
const changesOpen = shallowRef(false)
const closingTerminals = new Set<string>()
let syncing = false
let ready = false
const disposables: { dispose(): void }[] = []
const defaultTerminalCwd = computed(() => fleet.newSessionTarget?.workspace?.directories[0]?.path)
const headerActionsTarget = computed(() => topLeftGroupId.value ? windowHeaderActionsTarget(topLeftGroupId.value) : undefined)
const sessionLocation = computed(() => fleet.findSession(props.sessionId))
const chatTitle = computed(() => sessionLocation.value ? sessionLabel(sessionLocation.value.session) : t("panel.chat"))
const chatTooltip = computed(() => {
  const location = sessionLocation.value
  return location ? [location.machine.name, location.workspace?.name].filter(Boolean).join(" / ") : undefined
})
const sessionWorktreeId = computed(() => sessionLocation.value?.worktree?.id)
const sessionShells = computed(() => {
  const worktreeId = sessionWorktreeId.value
  return worktreeId
    ? terminals.sessions.filter(terminal => terminal.worktreeId === worktreeId && terminal.kind !== "acp")
    : []
})
const sessionShellIds = computed(() => sessionShells.value.map(terminal => terminal.id))

function addChangesPanel(group?: DockviewGroupPanel): void {
  const current = api.value
  if (!current || current.getPanel("changes")) return
  current.addPanel({
    id: "changes",
    component: "changes",
    title: t("panel.changes"),
    position: group
      ? { referenceGroup: group, direction: "within" }
      : { referencePanel: "chat", direction: "right" },
    initialWidth: group ? undefined : 288,
    minimumWidth: 220,
  })
  changesOpen.value = true
}

function addTerminalPanel(terminalId: string, title: string, group: DockviewGroupPanel, activate = false): void {
  const current = api.value
  const panelId = `terminal:${terminalId}`
  if (!current || current.getPanel(panelId)) return
  current.addPanel({
    id: panelId,
    component: "terminal",
    title,
    params: { terminalId },
    position: { referenceGroup: group, direction: "within" },
    inactive: !activate,
    minimumHeight: 120,
  })
}

function setChangesVisible(visible: boolean): void {
  const current = api.value
  if (!current) return
  if (visible) addChangesPanel()
  const panel = current.getPanel("changes")
  if (!panel) return
  if (visible) {
    panel.api.group.api.setVisible(true)
    panel.api.setActive()
  } else {
    // A hidden group must not hide neighbouring Chat or Shell tabs.
    if (panel.api.group.panels.length > 1) {
      const chat = current.getPanel("chat")
      if (chat) panel.api.moveTo({ group: chat.api.group, position: "right", skipSetActive: true })
    }
    panel.api.group.api.setVisible(false)
  }
  changesOpen.value = visible
}

function saveLayout(): void {
  const current = api.value
  if (!ready || syncing || !current) return
  stored.value = current.toJSON()
}

function updateTopLeftGroup(): void {
  const current = api.value
  const gridGroups = current?.groups.filter(group => group.api.location.type === "grid") ?? []
  const groups = gridGroups.flatMap(group => {
    const box = group.api.boundingBox
    return box && box.width > 0 && box.height > 0 ? [{ group, box }] : []
  })
  groups.sort((first, second) => first.box.top - second.box.top || first.box.left - second.box.left)
  topLeftGroupId.value = groups[0]?.group.id ?? gridGroups[0]?.id
}

function addChatPanel(current: DockviewApi): void {
  if (!current.getPanel("chat")) current.addPanel({ id: "chat", component: "chat", title: chatTitle.value })
}

function seed(current: DockviewApi): void {
  current.clear()
  addChatPanel(current)
  addChangesPanel()
}

function reconcileTerminalPanels(): void {
  const current = api.value
  if (!ready || !current || !terminals.loaded || !sessionWorktreeId.value) return

  syncing = true
  const shellIds = new Set(sessionShellIds.value)
  for (const panel of [...current.panels]) {
    const terminalId = terminalIdFromPanel(panel.id)
    if (terminalId && !shellIds.has(terminalId)) panel.api.close()
  }
  const defaultGroup = current.getPanel("chat")?.api.group
  if (defaultGroup) {
    for (const shell of sessionShells.value) addTerminalPanel(shell.id, shellTitle(shell.id), defaultGroup)
  }
  syncing = false
  saveLayout()
}

function scheduleTerminalReconcile(): void {
  if (!terminalReconcilePending.value) startTerminalReconcile()
}

const { isPending: terminalReconcilePending, start: startTerminalReconcile } = useTimeoutFn(reconcileTerminalPanels, 0, { immediate: false })

function onReady(event: DockviewReadyEvent): void {
  api.value = event.api
  if (stored.value) {
    const chat = stored.value.panels.chat
    const layout = chat
      ? { ...stored.value, panels: { ...stored.value.panels, chat: { ...chat, title: chatTitle.value } } }
      : stored.value
    try { event.api.fromJSON(layout) }
    catch { stored.value = null }
  }
  if (!event.api.getPanel("chat")) seed(event.api)
  ready = true
  const changes = event.api.getPanel("changes")
  changesOpen.value = !!changes?.api.group.api.isVisible
  updateTopLeftGroup()
  disposables.push(
    event.api.onDidLayoutChange(() => {
      updateTopLeftGroup()
      saveLayout()
    }),
    event.api.onDidRemovePanel(panel => {
      if (panel.id === "chat") queueMicrotask(() => {
        addChatPanel(event.api)
        saveLayout()
      })
      if (panel.id === "changes") changesOpen.value = false
    }),
  )
  scheduleTerminalReconcile()
  if (!terminals.loaded) void terminals.refresh().then(scheduleTerminalReconcile)
}

function terminalIdFromPanel(panelId: string): string | undefined {
  return panelId.startsWith("terminal:") ? panelId.slice("terminal:".length) : undefined
}

function closeTab(params: IDockviewPanelHeaderProps): void {
  if (params.api.id === "chat") return
  const terminalId = terminalIdFromPanel(params.api.id)
  if (terminalId) {
    if (closingTerminals.has(terminalId)) return
    closingTerminals.add(terminalId)
    void terminals.hangup(terminalId).then(() => {
      api.value?.getPanel(params.api.id)?.api.close()
      saveLayout()
    }).catch(reason => {
      terminals.error = reason instanceof Error ? reason.message : String(reason)
    }).finally(() => { closingTerminals.delete(terminalId) })
    return
  }

  syncing = true
  setChangesVisible(false)
  queueMicrotask(() => { syncing = false; saveLayout() })
}

function shellTitle(terminalId: string): string {
  const number = Math.max(1, sessionShells.value.findIndex(terminal => terminal.id === terminalId) + 1)
  return terminals.titles[terminalId]?.trim() || t("terminal.tab", { number })
}

async function openTerminalTab(group: DockviewGroupPanel): Promise<void> {
  const worktree = routeWorktree.value?.worktree
  try {
    const terminal = worktree
      ? await terminals.create({ worktreeId: worktree.id })
      : await terminals.create({ cwd: defaultTerminalCwd.value })
    addTerminalPanel(terminal.id, shellTitle(terminal.id), group, true)
    const panel = api.value?.getPanel(`terminal:${terminal.id}`)
    if (panel && panel.api.group.id !== group.id) panel.api.moveTo({ group, index: group.panels.length })
    panel?.api.setActive()
    saveLayout()
  } catch (reason) {
    terminals.error = reason instanceof Error ? reason.message : String(reason)
  }
}

function openWindowTab(id: WorkspaceWindowId, group: DockviewGroupPanel): void {
  if (id === "terminal") {
    void openTerminalTab(group)
    return
  }
  openChangesPanel(group)
}

function openChangesPanel(group?: DockviewGroupPanel): void {
  const current = api.value
  if (!ready || !current) return
  syncing = true
  const existing = current.getPanel("changes")
  if (existing) setChangesVisible(true)
  else {
    addChangesPanel(group)
    current.getPanel("changes")?.api.setActive()
  }
  changesOpen.value = true
  queueMicrotask(() => { syncing = false; saveLayout() })
}

watchArray(sessionShellIds, scheduleTerminalReconcile)
watch([() => terminals.loaded, sessionWorktreeId], scheduleTerminalReconcile)
watch(() => layout.detailsOpenRequest, () => openChangesPanel())

onScopeDispose(() => {
  ready = false
  api.value = undefined
  disposables.splice(0).forEach(disposable => disposable.dispose())
})
</script>

<template>
  <WindowTabBar
    :details-open="changesOpen"
    :chat-title="chatTitle"
    :chat-tooltip="chatTooltip"
    :top-left-group-id="topLeftGroupId"
    @ready="onReady"
    @close-tab="closeTab"
    @open-window="openWindowTab"
  >
    <template #chat><slot name="chat" :header-actions-target="headerActionsTarget" /></template>
    <template #changes><slot name="changes" /></template>
    <template #terminal="params"><slot name="terminal" v-bind="params" /></template>
  </WindowTabBar>
</template>
