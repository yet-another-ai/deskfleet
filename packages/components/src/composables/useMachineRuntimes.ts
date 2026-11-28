import { clearConversationOwner, conversationCacheKey, createConversationCache } from "../services/conversation-cache.ts"
import { createWorkspaceAgentClient } from "../services/workspace-agent-client.ts"
import { createPinia, disposePinia } from "pinia"
import { computed, createApp, h, inject, nextTick, onScopeDispose, ref, shallowReactive, vaporInteropPlugin, watch, type Component, type InjectionKey } from "vue"
import type { Machine } from "@deskfleet/client/central"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import { remoteMachineClient } from "@deskfleet/client/remote"
import { accountSessionKey, type AccountSession } from "./useAccountSession.ts"
import { platformClientKey } from "./usePlatformClient.ts"
import { createHiddenWorkspaces, type HiddenWorkspaces } from "./useHiddenWorkspaces.ts"
import { createSidebarFilter, type SidebarFilterState } from "./useSidebarFilter.ts"
import { createSidebarOrder, type SidebarOrder } from "./useSidebarOrder.ts"
import { createSidebarPanel, panelForRouteName, type SidebarPanelState } from "./useSidebarPanel.ts"
import { createWorkspaceAgentSummary, workspaceAgentSummaryKey, type WorkspaceAgentSummaryStore } from "./useWorkspaceAgentSummary.ts"
import { i18n } from "../i18n/index.ts"
import { router } from "../router/index.ts"
import { appearanceStoreKey, type useAppearanceStore } from "../stores/appearance.ts"
import { outlineAudioStoreKey, type useOutlineAudioStore } from "../stores/outline-audio.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { useFleetStore } from "../stores/fleet.ts"
import { useTerminalsStore } from "../stores/terminals.ts"
import { machineBatteriesKey, type MachineBatteriesStore } from "../stores/machine-batteries.ts"
import { installErrorReporting } from "../services/error-reporting.ts"

export interface MachineRuntime {
  state: ReturnType<typeof createPinia>
  api: DeskfleetDesktopApi
  refreshCatalog(): void | Promise<void>
  updateMachine(machine: Machine, rosterRefreshed?: boolean): void
  mount(component: Component, root: Element): () => void
  dispose(): void
}
export interface MachineRuntimes {
  opened: Map<string, MachineRuntime>
  sidebarScrollTop: number
  sidebarFilter: SidebarFilterState
  sidebarOrder: SidebarOrder
  hiddenWorkspaces: HiddenWorkspaces
  workspaceAgentSummary?: WorkspaceAgentSummaryStore
  sidebarPanel: SidebarPanelState
  open(machine: Machine): MachineRuntime
}

export const machineRuntimesKey: InjectionKey<MachineRuntimes> = Symbol("deskfleet machine runtimes")
export const useMachineRuntimes = () => inject(machineRuntimesKey, undefined)

/** Opened machines own their stores and peers until they leave the account's Team. */
export function createMachineRuntimes(
  host: DeskfleetDesktopApi,
  session: AccountSession,
  appearance: ReturnType<typeof useAppearanceStore>,
  outlineAudio: ReturnType<typeof useOutlineAudioStore>,
  batteries: MachineBatteriesStore,
): MachineRuntimes {
  const canUseWorkspaceAgent = host.platform !== "web" || host.remoteWorkspaceAgent === true
  const opened = shallowReactive(new Map<string, MachineRuntime>())
  const sidebarFilter = createSidebarFilter()
  const sidebarPanel = createSidebarPanel(panelForRouteName(router.currentRoute.value.name) ?? "conversations")
  function release(id: string): void {
    const runtime = opened.get(id)
    opened.delete(id)
    sidebarFilter.counts.delete(id)
    runtime?.dispose()
  }
  const identity = computed(() => JSON.stringify([session.account.value.serverUrl, session.account.value.user?.id, session.teamId.value]))
  const sidebarOrder = createSidebarOrder(identity)
  const hiddenWorkspaces = createHiddenWorkspaces(identity)
  const workspaceAgentSummary = createWorkspaceAgentSummary({ host, session })
  const owner = computed(() => JSON.stringify([session.account.value.serverUrl, session.account.value.user?.id]))
  watch(owner, (_, previous) => { void clearConversationOwner(previous) })
  watch(identity, () => {
    for (const id of opened.keys()) release(id)
    runtimes.sidebarScrollTop = 0
    sidebarFilter.filter.value = "all"
    sidebarFilter.counts.clear()
    workspaceAgentSummary.resetScope()
    sidebarPanel.reset()
  }, { flush: "sync" })
  watch(() => [session.machines.value.map(machine => ({ ...machine })), session.machineRosterVersion.value] as const, ([machines, version], [, previousVersion]) => {
    for (const [id, runtime] of opened) {
      const machine = machines.find(value => value.id === id)
      if (machine) runtime.updateMachine(machine, version !== undefined && version !== previousVersion)
      else release(id)
    }
  })
  onScopeDispose(() => {
    workspaceAgentSummary.dispose()
    for (const id of opened.keys()) release(id)
  })

  const runtimes: MachineRuntimes = {
    opened,
    sidebarScrollTop: 0,
    sidebarFilter,
    sidebarOrder,
    hiddenWorkspaces,
    workspaceAgentSummary,
    sidebarPanel,
    open(machine) {
      if (session.teamId.value !== machine.teamId) throw new Error("Machine is outside the selected team")
      const existing = opened.get(machine.id)
      if (existing) return existing
      function isLocal(previous: boolean): boolean {
        if (host.platform === "web") return false
        const enrollment = session.enrollment.value
        // Discovery can be temporarily unavailable after a known local registration.
        if (!enrollment) return previous
        return session.localMachineId.value === machine.id && enrollment.teamId === machine.teamId
      }
      const remote = remoteMachineClient(host, session.central, machine, { local: isLocal(false), rosterReady: session.machineRosterVersion.value !== undefined })
      const supportsRemoteFrontDesk = ref(machine.capabilities?.superAgent === true)
      const hasFrontDesk = () => !disposed && canUseWorkspaceAgent && (remote.api.target?.local
        ? !!host.localChannels && isLocal(true)
        : supportsRemoteFrontDesk.value && !isLocal(false))
      const frontDesk = createWorkspaceAgentClient(remote.api.agent, hasFrontDesk)
      Object.defineProperty(remote.api, "superAgent", { get: () => hasFrontDesk() ? frontDesk.api : undefined })
      const cache = createConversationCache(owner.value, JSON.stringify([machine.teamId, machine.id]))
      const state = createPinia()
      const views = new Set<() => void>()
      const renderViews = ref(true)
      let mounted = false
      let disposed = false
      let viewId = 0
      // A machine can join the roster before its first daemon capability report.
      // Check the first full catalog after connecting, including daemon upgrades.
      let awaitingCapabilityReport = !supportsRemoteFrontDesk.value
      let capabilityRequest = 0
      function refreshCapabilities() {
        const request = ++capabilityRequest
        const entry = session.machines.value.find(item => item.id === machine.id)
        void session.central.machines(machine.teamId).then(roster => {
          if (disposed || request !== capabilityRequest || !entry || !session.machines.value.includes(entry)) return
          const updated = roster.find(item => item.id === entry.id && item.teamId === entry.teamId)
          if (updated) entry.capabilities = updated.capabilities
        }).catch(() => { if (request === capabilityRequest) awaitingCapabilityReport = true })
      }
      if (canUseWorkspaceAgent && !remote.api.target?.local && machine.online && awaitingCapabilityReport) refreshCapabilities()
      const stopCapabilities = !canUseWorkspaceAgent ? undefined : session.central.onEvent(event => {
        if ((event.type !== "presence" && event.type !== "catalogChanged") ||
          event.teamId !== machine.teamId || event.machineId !== machine.id || remote.api.target?.local) return
        if (event.type === "presence") {
          if (event.online) awaitingCapabilityReport = true
        } else if (!event.sessionId && awaitingCapabilityReport) {
          awaitingCapabilityReport = false
          refreshCapabilities()
        }
      })
      // Reattach viewers when enrollment changes transport, including inactive machines.
      // Keep the adapter, stores, drafts, and current route throughout the transition.
      const stopLocal = watch(() => isLocal(remote.api.target?.local ?? false), async value => {
        frontDesk.close()
        if (!mounted) { remote.setLocal(value); return }
        renderViews.value = false
        await nextTick()
        if (disposed) return
        useAgentSessionsStore(state).closeTransport()
        useTerminalsStore(state).closeTransport()
        remote.setLocal(isLocal(remote.api.target?.local ?? false))
        renderViews.value = true
      })
      const runtime: MachineRuntime = {
        state,
        api: remote.api,
        refreshCatalog() {
          if (disposed) return
          remote.refreshCatalog()
          if (!mounted) return
          return useFleetStore(state).waitForCatalogRefresh()
        },
        updateMachine(value, rosterRefreshed) {
          remote.updateMachine(value, rosterRefreshed)
          supportsRemoteFrontDesk.value = value.capabilities?.superAgent === true
          if (!hasFrontDesk()) frontDesk.close()
        },
        mount(component, root) {
          const app = createApp({ render: () => renderViews.value ? h(component) : null })
            .provide(conversationCacheKey, cache)
            .provide(accountSessionKey, session)
            .provide(appearanceStoreKey, appearance)
            .provide(outlineAudioStoreKey, outlineAudio)
            .provide(platformClientKey, remote.api)
            .provide(machineRuntimesKey, runtimes)
            .provide(workspaceAgentSummaryKey, workspaceAgentSummary)
            .provide(machineBatteriesKey, batteries)
            .use(state).use(router).use(i18n)
          app.config.idPrefix = `machine-${machine.id}-${++viewId}`
          installErrorReporting(app)
          if (vaporInteropPlugin) app.use(vaporInteropPlugin)
          const unmount = () => { if (views.delete(unmount)) app.unmount() }
          views.add(unmount)
          app.mount(root)
          mounted = true
          return unmount
        },
        dispose() {
          disposed = true
          frontDesk.close()
          stopCapabilities?.()
          stopLocal()
          for (const unmount of views) unmount()
          disposePinia(state)
          remote.dispose()
        },
      }
      opened.set(machine.id, runtime)
      return runtime
    },
  }
  return runtimes
}
