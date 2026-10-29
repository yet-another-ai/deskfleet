import { createPinia, disposePinia } from "pinia"
import { computed, createApp, h, inject, nextTick, onScopeDispose, ref, shallowReactive, vaporInteropPlugin, watch, type Component, type InjectionKey } from "vue"
import type { Machine } from "@deskfleet/client/central"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import { remoteMachineClient } from "@deskfleet/client/remote"
import { accountSessionKey, type AccountSession } from "./useAccountSession.ts"
import { platformClientKey } from "./usePlatformClient.ts"
import { i18n } from "../i18n/index.ts"
import { router } from "../router/index.ts"
import { appearanceStoreKey, type useAppearanceStore } from "../stores/appearance.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { useTerminalsStore } from "../stores/terminals.ts"

export interface MachineRuntime {
  state: ReturnType<typeof createPinia>
  api: DeskfleetDesktopApi
  refreshCatalog(): void
  updateMachine(machine: Machine): void
  mount(component: Component, root: Element): () => void
  dispose(): void
}
export interface MachineRuntimes {
  opened: Map<string, MachineRuntime>
  open(machine: Machine): MachineRuntime
}

export const machineRuntimesKey: InjectionKey<MachineRuntimes> = Symbol("deskfleet machine runtimes")
export const useMachineRuntimes = () => inject(machineRuntimesKey, undefined)

/** Opened machines own their stores and peers until they leave the account's Team. */
export function createMachineRuntimes(host: DeskfleetDesktopApi, session: AccountSession, appearance: ReturnType<typeof useAppearanceStore>): MachineRuntimes {
  const opened = shallowReactive(new Map<string, MachineRuntime>())
  function release(id: string): void {
    const runtime = opened.get(id)
    opened.delete(id)
    runtime?.dispose()
  }
  const identity = computed(() => JSON.stringify([session.account.value.serverUrl, session.account.value.user?.id, session.teamId.value]))
  watch(identity, () => { for (const id of opened.keys()) release(id) }, { flush: "sync" })
  watch(() => session.machines.value.map(machine => ({ ...machine })), machines => {
    for (const [id, runtime] of opened) {
      const machine = machines.find(value => value.id === id)
      if (machine) runtime.updateMachine(machine)
      else release(id)
    }
  })
  onScopeDispose(() => { for (const id of opened.keys()) release(id) })

  const runtimes: MachineRuntimes = {
    opened,
    open(machine) {
      const existing = opened.get(machine.id)
      if (existing) return existing
      function isLocal(previous: boolean): boolean {
        if (host.platform === "web") return false
        const enrollment = session.enrollment.value
        // Discovery can be temporarily unavailable after a known local registration.
        if (!enrollment) return previous
        return session.localMachineId.value === machine.id && enrollment.teamId === machine.teamId
      }
      const remote = remoteMachineClient(host, session.central, machine, { local: isLocal(false) })
      const state = createPinia()
      const views = new Set<() => void>()
      const renderViews = ref(true)
      let mounted = false
      let disposed = false
      let viewId = 0
      // Reattach viewers when enrollment changes transport, including inactive machines.
      // Keep the adapter, stores, drafts, and current route throughout the transition.
      const stopLocal = watch(() => isLocal(remote.api.target?.local ?? false), async value => {
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
        refreshCatalog: remote.refreshCatalog,
        updateMachine: remote.updateMachine,
        mount(component, root) {
          const app = createApp({ render: () => renderViews.value ? h(component) : null })
            .provide(accountSessionKey, session)
            .provide(appearanceStoreKey, appearance)
            .provide(platformClientKey, remote.api)
            .provide(machineRuntimesKey, runtimes)
            .use(state).use(router).use(i18n)
          app.config.idPrefix = `machine-${machine.id}-${++viewId}`
          if (vaporInteropPlugin) app.use(vaporInteropPlugin)
          const unmount = () => { if (views.delete(unmount)) app.unmount() }
          views.add(unmount)
          app.mount(root)
          mounted = true
          return unmount
        },
        dispose() {
          disposed = true
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
