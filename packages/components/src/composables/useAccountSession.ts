import { computed, inject, ref, type ComputedRef, type InjectionKey, type Ref } from "vue"
import type { AccountState, CentralApi, LocalEnrollment, Machine, SiteSettings, Team, TeamMember } from "@deskfleet/client/central"
import { router } from "../router/index.ts"

export type AccountDialog = "create-team" | "join-team" | "add-machine"
export type AccountSettingsSection = "preferences" | "appearance" | "notifications" | "team"
export interface HeadlessMachine { name: string; originId: string; localMachineId: string }

/**
 * The signed-in account, its selected Team and Machine, and the actions that change them.
 * It outlives each machine's isolated application scope, which receives it by injection.
 * User-initiated actions reject so the dialog or control that started them can show the
 * failure; background refreshes report through `notice` instead.
 */
export interface AccountSession {
  central: CentralApi
  /** False until the first account status arrives, so no signed-out flash precedes it. */
  ready: Ref<boolean>
  account: Ref<AccountState>
  site: Ref<SiteSettings | undefined>
  teams: Ref<Team[]>
  teamId: Ref<string | undefined>
  team: ComputedRef<Team | undefined>
  members: Ref<TeamMember[]>
  machines: Ref<Machine[]>
  machineId: Ref<string | undefined>
  machine: ComputedRef<Machine | undefined>
  enrollment: Ref<LocalEnrollment | undefined>
  /** The central ID of this computer's active registration with the signed-in server. */
  localMachineId: ComputedRef<string | undefined>
  /** This computer can register (again) with the selected Team. */
  canEnrollLocal: ComputedRef<boolean>
  connected: Ref<boolean>
  notice: Ref<string | undefined>
  dialog: Ref<AccountDialog | undefined>
  /** Settings shown by the account shell while the Team has no machine to host them. */
  shellSettings: Ref<AccountSettingsSection | undefined>
  reload(): Promise<void>
  refreshMachines(): Promise<void>
  signIn(serverUrl: string): Promise<void>
  signOut(): Promise<void>
  selectTeam(id: string): Promise<void>
  selectMachine(id: string): void
  createTeam(name: string): Promise<void>
  joinTeam(code: string): Promise<void>
  renameTeam(name: string): Promise<void>
  /** Registers this computer under the given name, or its hostname. */
  enrollLocal(name?: string): Promise<void>
  enrollHeadless(machine: HeadlessMachine): Promise<{ machine: Machine; token: string }>
  renameMachine(id: string, name: string): Promise<void>
  removeMachine(id: string): Promise<void>
  openSettings(section: AccountSettingsSection): void
  dispose(): void
}

const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)

export function createAccountSession(central: CentralApi, initialNotice?: string): AccountSession {
  const ready = ref(false)
  const account = ref<AccountState>({ serverUrl: "", siteAdmin: false })
  const site = ref<SiteSettings>()
  const teams = ref<Team[]>([])
  const teamId = ref<string>()
  const members = ref<TeamMember[]>([])
  const machines = ref<Machine[]>([])
  const machineId = ref<string>()
  const enrollment = ref<LocalEnrollment>()
  const connected = ref(true)
  const notice = ref(initialNotice)
  const dialog = ref<AccountDialog>()
  const shellSettings = ref<AccountSettingsSection>()
  const team = computed(() => teams.value.find(value => value.id === teamId.value))
  const machine = computed(() => machines.value.find(value => value.id === machineId.value))
  const localMachineId = computed(() => {
    const value = enrollment.value
    return value?.configured && !value.revoked && value.serverUrl === account.value.serverUrl ? value.machineId : undefined
  })
  const canEnrollLocal = computed(() => !!central.enrollLocal && !!enrollment.value && (!enrollment.value.configured || enrollment.value.revoked))
  // A slower response for a Team the user has already left must not replace the current list.
  let machinesRevision = 0
  let membersRevision = 0

  async function background(work: () => Promise<void>): Promise<void> {
    try { await work(); notice.value = undefined } catch (reason) { notice.value = message(reason) }
  }
  async function loadEnrollment(): Promise<void> {
    enrollment.value = await central.localEnrollment?.().catch(() => undefined)
  }
  async function loadMembers(): Promise<void> {
    const revision = ++membersRevision
    const selected = teamId.value
    const list = selected ? await central.members(selected) : []
    if (revision === membersRevision) members.value = list
  }
  async function loadMachines(preferred?: string): Promise<void> {
    const revision = ++machinesRevision
    const selected = teamId.value
    const list = selected ? await central.machines(selected) : []
    if (revision !== machinesRevision) return
    machines.value = list
    // Keep the current machine; otherwise open this computer, then any reachable machine.
    const candidates = [preferred, machineId.value, localMachineId.value]
    machineId.value = candidates.find(id => list.some(value => value.id === id))
      ?? list.find(value => value.online)?.id ?? list[0]?.id
    if (machineId.value) shellSettings.value = undefined
  }
  function refreshMachines(): Promise<void> {
    return background(async () => { await loadEnrollment(); await loadMachines() })
  }
  async function reload(): Promise<void> {
    account.value = await central.status()
    // Keep the last public site until a replacement arrives so focus refreshes do not
    // blank the title, announcement, or create-team controls while site() is in flight.
    const loadSite = central.site().then(value => { site.value = value })
    if (!account.value.user) {
      ++machinesRevision
      ++membersRevision
      teams.value = []; teamId.value = undefined; machines.value = []; machineId.value = undefined
      members.value = []
      dialog.value = undefined; shellSettings.value = undefined
      await loadSite
      return
    }
    const [list] = await Promise.all([central.teams(), loadEnrollment(), loadSite])
    teams.value = list
    if (!list.some(value => value.id === teamId.value)) {
      const enrolledTeam = enrollment.value?.serverUrl === account.value.serverUrl ? enrollment.value.teamId : undefined
      teamId.value = (list.find(value => value.id === enrolledTeam) ?? list[0])?.id
      machineId.value = undefined
      members.value = []
    }
    await Promise.all([loadMachines(), loadMembers()])
  }
  async function selectTeam(id: string): Promise<void> {
    if (id === teamId.value) return
    teamId.value = id
    machineId.value = undefined
    machines.value = []
    members.value = []
    await background(async () => { await Promise.all([loadMachines(), loadMembers()]) })
  }
  async function enrollLocal(name?: string): Promise<void> {
    if (!central.enrollLocal || !teamId.value) throw new Error("This computer cannot be connected from this client")
    enrollment.value = await central.enrollLocal(teamId.value, name)
    await loadMachines(enrollment.value.machineId)
  }
  async function enrollHeadless(value: HeadlessMachine): Promise<{ machine: Machine; token: string }> {
    if (!teamId.value) throw new Error("Select a team first")
    const result = await central.enrollHeadless(teamId.value, value)
    await background(() => loadMachines())
    return result
  }
  // The open machine's own catalog follows through the server's change notification.
  async function renameMachine(id: string, name: string): Promise<void> {
    const renamed = await central.renameMachine(id, name)
    machines.value = machines.value.map(value => value.id === id ? { ...value, name: renamed.name } : value)
  }
  async function removeMachine(id: string): Promise<void> {
    await central.removeMachine(id)
    if (machineId.value === id) machineId.value = undefined
    await Promise.all([loadEnrollment(), loadMachines()])
  }
  function openSettings(section: AccountSettingsSection): void {
    if (machineId.value) void router.push({ name: `settings-${section}` })
    else shellSettings.value = section
  }

  const unsubscribe = central.onEvent(event => {
    if (event.type === "accountChanged") void background(reload)
    else if (event.type === "connection") {
      connected.value = event.connected
      if (event.connected) void background(reload)
    } else if (event.type === "machinesChanged" && event.teamId === teamId.value) void refreshMachines()
    else if (event.type === "presence") {
      const target = machines.value.find(value => value.id === event.machineId)
      if (target) target.online = event.online
    }
  })
  void background(reload).finally(() => { ready.value = true; if (initialNotice) notice.value = initialNotice })

  return {
    central, ready, account, site, teams, teamId, team, members, machines, machineId, machine, enrollment, localMachineId, canEnrollLocal,
    connected, notice, dialog, shellSettings, reload,
    refreshMachines,
    async signIn(serverUrl) { await central.setServer(serverUrl); await central.login(); await reload() },
    async signOut() { await central.logout(); await reload() },
    selectTeam,
    selectMachine(id) { if (machines.value.some(value => value.id === id)) machineId.value = id },
    async createTeam(name) {
      const created = await central.createTeam(name)
      teams.value = [...teams.value, created]
      await selectTeam(created.id)
    },
    async joinTeam(code) {
      const joined = await central.acceptInvite(code)
      teams.value = await central.teams()
      await selectTeam(joined.id)
    },
    async renameTeam(name) {
      if (!teamId.value) return
      const renamed = await central.renameTeam(teamId.value, name)
      teams.value = teams.value.map(value => value.id === renamed.id ? { ...value, name: renamed.name } : value)
    },
    enrollLocal, enrollHeadless, renameMachine, removeMachine, openSettings,
    dispose: unsubscribe,
  }
}

export const accountSessionKey: InjectionKey<AccountSession> = Symbol("deskfleet account")
/** Undefined in the local-only desktop, which has no account. */
export function useAccountSession(): AccountSession | undefined {
  return inject(accountSessionKey, undefined)
}
