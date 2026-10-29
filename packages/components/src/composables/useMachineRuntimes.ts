import { createPinia, disposePinia } from "pinia"
import { computed, createApp, inject, onScopeDispose, shallowReactive, vaporInteropPlugin, watch, type Component, type InjectionKey } from "vue"
import type { Machine } from "@deskfleet/client/central"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import { remoteMachineClient } from "@deskfleet/client/remote"
import { accountSessionKey, type AccountSession } from "./useAccountSession.ts"
import { platformClientKey } from "./usePlatformClient.ts"
import { i18n } from "../i18n/index.ts"
import { router } from "../router/index.ts"
import { appearanceStoreKey, type useAppearanceStore } from "../stores/appearance.ts"

export interface MachineRuntime {
  state: ReturnType<typeof createPinia>
  api: DeskfleetDesktopApi
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
      const remote = remoteMachineClient(host, session.central, machine)
      const state = createPinia()
      const views = new Set<() => void>()
      let viewId = 0
      const runtime: MachineRuntime = {
        state,
        api: remote.api,
        updateMachine: remote.updateMachine,
        mount(component, root) {
          const app = createApp(component)
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
          return unmount
        },
        dispose() {
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
