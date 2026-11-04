<script setup lang="ts">
import "dockview-vue/dist/styles/dockview.css"
import { MonitorPlay, Plus, SquareTerminal } from "@lucide/vue"
import { StorageSerializers, useLocalStorage, useTimeoutFn } from "@vueuse/core"
import { computed, defineAsyncComponent, onScopeDispose, provide, shallowRef, toRaw, watch } from "vue"
import { useI18n } from "vue-i18n"
import {
  DockviewVue,
  type DockviewApi,
  type DockviewGroupPanel,
  type DockviewPanelApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type SerializedDockview,
  themeLight,
} from "dockview-vue"
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "reka-ui"
import { truncateGeneratedTitle } from "../../../../../apps/daemon/src/titles.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { useSessionLabel } from "../../composables/useSessionLabel.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { useLayoutStore, type SessionWindowRequest } from "../../stores/layout.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import IconButton from "../common/IconButton.vue"
import ChangesPanel from "../details/ChangesPanel.vue"
import SessionPreviewWindow from "../session/SessionPreviewWindow.vue"
import AppMainWindow from "./AppMainWindow.vue"
import SessionDesktopWindow from "./SessionDesktopWindow.vue"
import WindowTab from "./WindowTab.vue"
import WindowToolbar from "./WindowToolbar.vue"
import { newTerminalWindowKey, windowHeaderActionsId, windowHeaderActionsTarget } from "./windowHeaderActions.ts"

type WorkspaceWindowId = "changes" | "desktops" | "terminal"

const props = defineProps<{ sessionId: string }>()
const { t } = useI18n()
const platform = usePlatformClient().platform
const fleet = useFleetStore()
const layout = useLayoutStore()
const terminals = useTerminalsStore()
const sessionLabel = useSessionLabel()
const stored = useLocalStorage<SerializedDockview | null>(() => `deskfleet.window-layout-v4:${props.sessionId}`, null, {
  serializer: StorageSerializers.object,
})
const api = shallowRef<DockviewApi>()
const topLeftGroupId = shallowRef<string>()
const changesOpen = shallowRef(false)
const desktopsOpen = shallowRef(false)
const closingTerminals = new Set<string>()
let syncing = false
const disposables: { dispose(): void }[] = []
const TerminalShellWindow = defineAsyncComponent(() => import("../terminal/TerminalShellWindow.vue"))
const headerActionsTarget = computed(() => topLeftGroupId.value ? windowHeaderActionsTarget(topLeftGroupId.value) : undefined)
const toolbarNeedsTrafficLightInset = computed(() => platform === "darwin" && !layout.sidebarOpen)
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

provide(newTerminalWindowKey, () => {
  const group = api.value?.groups.find(group => group.id === topLeftGroupId.value)
  if (group) void openTerminalTab(group, "below")
})

function tabPresentation(params: IDockviewPanelHeaderProps): { title: string; tooltip: string; closable: boolean } {
  if (params.api.id === "chat") {
    return {
      title: chatTitle.value,
      tooltip: chatTooltip.value ?? chatTitle.value,
      closable: false,
    }
  }

  const title = params.api.title ?? params.api.id
  return { title, tooltip: title, closable: true }
}

function updateTerminalTitle(panel: DockviewPanelApi, terminalId: string, title: string): void {
  const capped = truncateGeneratedTitle(title)
  terminals.titles[terminalId] = capped
  panel.setTitle(capped)
}

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

function addTerminalPanel(terminalId: string, title: string, group: DockviewGroupPanel, activate = false, direction: "within" | "below" = "within"): void {
  const current = api.value
  const panelId = `terminal:${terminalId}`
  if (!current || current.getPanel(panelId)) return
  current.addPanel({
    id: panelId,
    component: "terminal",
    title,
    params: { terminalId },
    position: { referenceGroup: group, direction },
    inactive: !activate,
    minimumHeight: 120,
  })
}

function addDesktopsPanel(group?: DockviewGroupPanel): void {
  const current = api.value
  if (!current || current.getPanel("desktops")) return
  const target = group ?? rightWindowGroup(current)
  const panel = current.addPanel({
    id: "desktops",
    component: "desktops",
    title: t("desktopOverview.title"),
    position: target ? { referenceGroup: target, direction: "within" } : { referencePanel: "chat", direction: "right" },
    inactive: true,
    initialWidth: target ? undefined : 336,
    minimumWidth: 220,
  })
  // A restored Chat-only layout has no selected neighboring tab. Keep the new
  // group hidden until the user explicitly opens desktop previews from +.
  if (!target) panel.api.group.api.setVisible(false)
  desktopsOpen.value = !!target?.api.isVisible
}

function isPreviewPanel(panelId: string): boolean {
  return panelId.startsWith("preview:") || panelId.startsWith("mermaid-preview:")
}

function rightWindowGroup(current: DockviewApi): DockviewGroupPanel | undefined {
  const openPreview = current.panels.find(panel => isPreviewPanel(panel.id))
  const tools = [current.getPanel("changes"), current.getPanel("desktops")]
  return openPreview?.api.group ?? tools.find(panel => panel?.api.group.api.isVisible)?.api.group ?? tools.find(Boolean)?.api.group
}

function resourceWindowTitle(request: Extract<SessionWindowRequest, { kind: "resource" }>): string {
  if (request.item.title) return request.item.title
  const rawName = request.item.request.uri.replace(/[?#].*$/u, "").split(/[\\/]/u).filter(Boolean).at(-1)
  if (rawName) {
    try { return decodeURIComponent(rawName) } catch { return rawName }
  }
  return request.item.request.uri
}

function openSessionWindow(request: SessionWindowRequest): void {
  const current = api.value
  if (!current) return
  const contentRequest = structuredClone(toRaw(request))
  const windowId = `${contentRequest.kind === "mermaid" ? "mermaid-preview" : "preview"}:${crypto.randomUUID()}`
  const group = rightWindowGroup(current)

  current.addPanel({
    id: windowId,
    component: "sessionPreview",
    title: contentRequest.kind === "preview"
      ? contentRequest.item.title || (contentRequest.item.kind === "image" ? t("agent.image") : t("agent.contentType", { type: contentRequest.item.kind }))
      : contentRequest.kind === "resource"
        ? resourceWindowTitle(contentRequest)
        : t("mermaid.title"),
    params: { request: contentRequest },
    position: group
      ? { referenceGroup: group, direction: "within" }
      : { referencePanel: "chat", direction: "right" },
    minimumWidth: 220,
  })
  const panel = current.getPanel(windowId)
  panel?.api.group.api.setVisible(true)
  panel?.api.setActive()
  saveLayout()
}

function setToolVisible(id: "changes" | "desktops", visible: boolean): void {
  const current = api.value
  if (!current) return
  if (visible) { if (id === "changes") addChangesPanel(); else addDesktopsPanel() }
  const panel = current.getPanel(id)
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
  if (id === "changes") changesOpen.value = visible
  else desktopsOpen.value = visible
}

function saveLayout(): void {
  const current = api.value
  if (syncing || !current) return
  const serialized = current.toJSON()
  for (const [panelId, panel] of Object.entries(serialized.panels)) {
    if (isPreviewPanel(panelId)) delete panel.params
  }
  stored.value = serialized
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
  addDesktopsPanel(current.getPanel("changes")?.api.group)
}

function reconcileTerminalPanels(): void {
  const current = api.value
  if (!current || !terminals.loaded || !sessionWorktreeId.value) return

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
  try {
    if (stored.value) event.api.fromJSON(stored.value)
  } catch {
    stored.value = null
  }

  // Preview contents are intentionally transient; their data is removed before layout
  // persistence, so restored preview entries have no content and are discarded.
  let removedStoredPreview = false
  for (const panel of [...event.api.panels]) {
    if (isPreviewPanel(panel.id)) {
      event.api.removePanel(panel)
      removedStoredPreview = true
    }
  }
  if (removedStoredPreview) saveLayout()

  const chat = event.api.getPanel("chat")
  if (chat) chat.api.setTitle(chatTitle.value)
  else seed(event.api)
  // Existing Session layouts gain the tab without activating capture. A closed
  // desktop tab persists as a hidden panel, so it stays closed on later visits.
  if (!event.api.getPanel("desktops")) addDesktopsPanel()
  const changes = event.api.getPanel("changes")
  changesOpen.value = !!changes?.api.group.api.isVisible
  desktopsOpen.value = !!event.api.getPanel("desktops")?.api.group.api.isVisible
  updateTopLeftGroup()
  disposables.push(
    // Only individual tabs move between groups; header space moves the app window.
    event.api.onWillDragGroup(event => event.nativeEvent.preventDefault()),
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
      if (panel.id === "desktops") desktopsOpen.value = false
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

  if (params.api.id === "changes" || params.api.id === "desktops") {
    const id = params.api.id
    queueMicrotask(() => {
      syncing = true
      setToolVisible(id, false)
      syncing = false
      saveLayout()
    })
    return
  }

  const panelId = params.api.id
  queueMicrotask(() => {
    const current = api.value
    const panel = current?.getPanel(panelId)
    if (!current || !panel) return
    panel.api.close()
    saveLayout()
  })
}

function shellTitle(terminalId: string): string {
  const number = Math.max(1, sessionShells.value.findIndex(terminal => terminal.id === terminalId) + 1)
  return terminals.titles[terminalId]?.trim() || t("terminal.tab", { number })
}

async function openTerminalTab(group: DockviewGroupPanel, direction: "within" | "below" = "within"): Promise<void> {
  const worktreeId = sessionWorktreeId.value
  if (!worktreeId) return
  try {
    const terminal = await terminals.create({ worktreeId })
    addTerminalPanel(terminal.id, shellTitle(terminal.id), group, true, direction)
    const panel = api.value?.getPanel(`terminal:${terminal.id}`)
    if (direction === "within" && panel && panel.api.group.id !== group.id) panel.api.moveTo({ group, index: group.panels.length })
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
  openToolPanel(id, group)
}

function openToolPanel(id: "changes" | "desktops", group?: DockviewGroupPanel): void {
  const current = api.value
  if (!current) return
  syncing = true
  const existing = current.getPanel(id)
  if (existing) {
    if (id === "desktops" && group && existing.api.group !== group) existing.api.moveTo({ group, index: group.panels.length })
    setToolVisible(id, true)
  }
  else {
    if (id === "changes") addChangesPanel(group)
    else addDesktopsPanel(group)
    current.getPanel(id)?.api.setActive()
  }
  if (id === "changes") changesOpen.value = true
  else desktopsOpen.value = true
  queueMicrotask(() => { syncing = false; saveLayout() })
}

watch([sessionShellIds, () => terminals.loaded, sessionWorktreeId], scheduleTerminalReconcile)
watch(() => layout.sessionWindowRequest?.id, () => {
  const request = layout.sessionWindowRequest
  if (request) openSessionWindow(request)
})

onScopeDispose(() => {
  api.value = undefined
  disposables.splice(0).forEach(disposable => disposable.dispose())
})
</script>

<template>
  <section class="deskfleet-windows min-h-0 min-w-0 flex-1" :aria-label="t('toolbar.windows')">
    <DockviewVue
      class="h-full w-full"
      :theme="themeLight"
      :get-tab-context-menu-items="() => []"
      @ready="onReady"
    >
      <template #panel-chat>
        <AppMainWindow windowed :window-header-actions-target="headerActionsTarget" />
      </template>
      <template #panel-changes>
        <ChangesPanel windowed class="h-full" />
      </template>
      <template #panel-desktops="{ api: panelApi }">
        <SessionDesktopWindow :session-id="sessionId" :panel-api="panelApi" />
      </template>
      <template #panel-terminal="{ api: panelApi, params }">
        <TerminalShellWindow
          :terminal-id="params.terminalId"
          @title="updateTerminalTitle(panelApi, params.terminalId, $event)"
        />
      </template>
      <template #panel-sessionPreview="{ params }">
        <SessionPreviewWindow v-if="params.request" :request="params.request" />
      </template>
      <template #defaultTab="params">
        <WindowTab
          :tab-id="params.api.id"
          v-bind="tabPresentation(params)"
          :close-label="t('toolbar.closeWindow', { title: params.api.title })"
          @close="closeTab(params)"
        />
      </template>
      <template #prefixHeaderActions="{ group }">
        <div
          v-if="group.id === topLeftGroupId"
          class="ml-1 flex h-full items-center pr-[3px]"
          :class="{ 'pl-20': toolbarNeedsTrafficLightInset }"
          :data-window-toolbar-group="group.id"
        >
          <WindowToolbar :history="false" />
        </div>
      </template>
      <template #leftHeaderActions="{ group }">
        <DropdownMenuRoot :modal="false">
          <DropdownMenuTrigger :as="IconButton" :icon="Plus" :label="t('toolbar.addWindow')" class="app-no-drag mx-[3px]" />
          <DropdownMenuPortal>
            <DropdownMenuContent align="start" :side-offset="4" :collision-padding="8" :aria-label="t('toolbar.addWindow')" class="app-no-drag ui-menu z-50 flex w-44 flex-col" loop>
              <DropdownMenuItem as="button" type="button" data-window-type="changes" class="ui-menu-item" :disabled="changesOpen" @select="openWindowTab('changes', group)">
                <span class="text-xs font-semibold" aria-hidden="true">±</span>{{ t("panel.changes") }}
              </DropdownMenuItem>
              <DropdownMenuItem as="button" type="button" data-window-type="desktops" class="ui-menu-item" :disabled="desktopsOpen" @select="openWindowTab('desktops', group)">
                <MonitorPlay :size="14" aria-hidden="true" />{{ t("desktopOverview.title") }}
              </DropdownMenuItem>
              <DropdownMenuItem as="button" type="button" data-window-type="terminal" class="ui-menu-item" :disabled="!sessionWorktreeId" @select="openWindowTab('terminal', group)">
                <SquareTerminal :size="14" aria-hidden="true" />{{ t("terminal.new") }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
      </template>
      <template #rightHeaderActions="{ group }">
        <div :id="windowHeaderActionsId(group.id)" class="mr-[6px] flex h-full items-center gap-[6px]" data-window-header-actions :data-window-header-actions-group="group.id" />
      </template>
    </DockviewVue>
  </section>
</template>

<style scoped>
.deskfleet-windows :deep(.dockview-theme-light) {
  /* Undo dockview's forced light scheme so light-dark() tokens follow Appearance. */
  color-scheme: inherit;
  --dv-group-view-background-color: var(--ui-color-canvas);
  --dv-tabs-and-actions-container-background-color: var(--ui-color-canvas);
  --dv-activegroup-visiblepanel-tab-background-color: color-mix(in srgb, var(--ui-color-accent) 12%, transparent);
  --dv-activegroup-hiddenpanel-tab-background-color: transparent;
  --dv-inactivegroup-visiblepanel-tab-background-color: color-mix(in srgb, var(--ui-color-accent) 12%, transparent);
  --dv-inactivegroup-hiddenpanel-tab-background-color: transparent;
  --dv-activegroup-visiblepanel-tab-color: var(--ui-color-accent);
  --dv-activegroup-hiddenpanel-tab-color: var(--ui-color-text);
  --dv-inactivegroup-visiblepanel-tab-color: var(--ui-color-accent);
  --dv-inactivegroup-hiddenpanel-tab-color: var(--ui-color-text);
  --dv-tab-divider-color: var(--ui-color-border);
  --dv-separator-border: var(--ui-color-border);
  --dv-icon-hover-background-color: var(--ui-color-hover);
  --dv-active-sash-color: var(--ui-color-focus);
  --dv-drag-over-background-color: color-mix(in srgb, var(--ui-color-accent) 18%, transparent);
  --dv-drag-over-border: 1px solid var(--ui-color-accent);
  --dv-drag-over-border-color: var(--ui-color-accent);
  --dv-edge-dock-indicator-color: var(--ui-color-accent);
  --dv-tabs-and-actions-container-height: 48px;
  --dv-tab-margin: 6px 3px;
  --dv-floating-border: 1px solid var(--ui-color-border-strong);
  --dv-floating-box-shadow: var(--ui-shadow-dialog);
}
.deskfleet-windows :deep(.dv-tabs-and-actions-container) {
  app-region: drag;
  -webkit-app-region: drag;
  padding-left: 2px;
  border-bottom: 1px solid var(--ui-color-border);
}
.deskfleet-windows :deep(.dv-tab),
.deskfleet-windows :deep(.dv-tabs-overflow-dropdown-default) {
  app-region: no-drag;
  -webkit-app-region: no-drag;
}
.deskfleet-windows :deep(.dv-tab) {
  height: 36px;
  cursor: pointer;
  padding: 0;
  border-radius: 0.5rem;
  transition: background-color var(--ui-duration-fast) var(--ui-ease-out), color var(--ui-duration-fast) var(--ui-ease-out);
}
/* The window that comes forward settles into its highlight, like a selected nav item. */
.deskfleet-windows :deep(.dv-active-tab) { animation: ui-nav-select var(--ui-duration-base) var(--ui-ease-out); }
.deskfleet-windows :deep(.dv-tab::before) { display: none; }
.deskfleet-windows :deep(.dv-active-tab:hover) { background: color-mix(in srgb, var(--ui-color-accent) 20%, transparent); }
.deskfleet-windows :deep(.dv-inactive-tab:hover) { background: var(--ui-color-hover); }
.deskfleet-windows :deep(.dv-pre-actions-container > .dv-vue-part),
.deskfleet-windows :deep(.dv-left-actions-container > .dv-vue-part),
.deskfleet-windows :deep(.dv-right-actions-container > .dv-vue-part) {
  display: flex;
  align-items: center;
}
.deskfleet-windows :deep(.dv-sash) { transition: background-color var(--ui-duration-fast) var(--ui-ease-out); }
.deskfleet-windows :deep(.dv-sash:hover) { background: color-mix(in srgb, var(--ui-color-focus) 45%, transparent); }
</style>
