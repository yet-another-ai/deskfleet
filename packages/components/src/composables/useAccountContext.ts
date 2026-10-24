import { inject, type ComputedRef, type InjectionKey, type Ref } from "vue"
import type { AccountState, CentralApi, LocalEnrollment, Machine, Team } from "@deskfleet/client/central"

/** Account navigation survives the isolated application scope of each machine. */
export interface AccountContext {
  central: CentralApi
  account: Ref<AccountState>
  teams: Ref<Team[]>
  team: ComputedRef<Team | undefined>
  teamId: Ref<string>
  machines: Ref<Machine[]>
  machineId: Ref<string>
  enrollment: Ref<LocalEnrollment | undefined>
  canEnroll: ComputedRef<boolean>
  busy: Ref<boolean>
  error: Ref<string | undefined>
  connected: Ref<boolean>
  selectTeam(id: string): Promise<void>
  selectMachine(id: string): Promise<void>
  createTeam(): void
  joinTeam(): void
  manageTeam(): void
  enrollHeadless(): void
  enrollLocal(): Promise<void>
  refresh(): Promise<void>
  reload(): Promise<void>
  logout(): Promise<void>
}

export const accountContextKey: InjectionKey<AccountContext> = Symbol("deskfleet account")
export function useAccountContext(): AccountContext | undefined {
  return inject(accountContextKey, undefined)
}
