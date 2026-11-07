import { computed, ref, type ComputedRef, type Ref } from "vue"
import type { RouteLocationRaw } from "vue-router"
import type { AccountState, CentralApi, LocalEnrollment, LocalMachineStatus, Machine, SiteSettings, Team, TeamMember } from "@deskfleet/client/central"
import { withCentralRequestTrigger } from "@deskfleet/client/reporting-central"
import { router } from "../router/index.ts"
import { captureAnalyticsContext } from "../services/analytics.ts"

export { accountSessionKey, useAccountSession } from "./account-session-context.ts"

export type AccountDialog = "create-team" | "join-team" | "add-machine"
export type AccountSettingsSection = "preferences" | "appearance" | "notifications" | "team" | "plans"
export interface HeadlessMachine { name: string; originId: string; localMachineId: string; identityToken: string }

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
  /** Undefined while signaling needs reconciliation; advances after a complete roster read. */
  machineRosterVersion: Ref<number | undefined>
  machineId: Ref<string | undefined>
  machine: ComputedRef<Machine | undefined>
  /** Team-wide search survives switching a result into another machine's surface. */
  searchPath: Ref<string>
  localStatus: Ref<LocalMachineStatus | undefined>
  enrollment: ComputedRef<LocalEnrollment | undefined>
  /** The central ID of this computer's active registration with the signed-in server. */
  localMachineId: ComputedRef<string | undefined>
  /** This computer can register (again) with the selected Team. */
  canEnrollLocal: ComputedRef<boolean>
  connected: Ref<boolean>
  notice: Ref<string | undefined>
  dialog: Ref<AccountDialog | undefined>
  reload(): Promise<void>
  refreshMachines(): Promise<void>
  signIn(): Promise<void>
  signOut(): Promise<void>
  selectTeam(id: string): Promise<void>
  selectMachine(id: string): void
  /** Selects a Machine before navigating to one of its machine-local resources. */
  openMachineRoute(machineId: string, destination: RouteLocationRaw): void
  /** Consumed once by the selected Machine surface during initialization. */
  takeMachineDestination(machineId: string): RouteLocationRaw | undefined
  /** Opens a Session in its owning Machine's isolated application scope. */
  openSession(machineId: string, sessionId: string): void
  /** Consumed once by the selected Machine surface during initialization. */
  takeSessionDestination(machineId: string): string | undefined
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
  const automatic = withCentralRequestTrigger(central, "background")
  const user = withCentralRequestTrigger(central, "user")
  const ready = ref(false)
  const account = ref<AccountState>({ serverUrl: "", siteAdmin: false })
  const site = ref<SiteSettings>()
  const teams = ref<Team[]>([])
  const teamId = ref<string>()
  const members = ref<TeamMember[]>([])
  const machines = ref<Machine[]>([])
  const machineRosterVersion = ref<number>()
  const machineId = ref<string>()
  const searchPath = ref("/search")
  const localStatus = ref<LocalMachineStatus>()
  const enrollment = computed(() => localStatus.value?.registrations.find(value => value.serverUrl === account.value.serverUrl && value.teamId === teamId.value))
  const connected = ref(true)
  const notice = ref(initialNotice)
  const dialog = ref<AccountDialog>()
  const team = computed(() => teams.value.find(value => value.id === teamId.value))
  const machine = computed(() => machines.value.find(value => value.id === machineId.value))
  const localMachineId = computed(() => {
    const value = enrollment.value
    return value?.configured && !value.revoked && value.serverUrl === account.value.serverUrl ? value.machineId : undefined
  })
  const canEnrollLocal = computed(() => !!central.enrollLocal && !!localStatus.value && (!enrollment.value?.configured || enrollment.value.revoked))
  // A slower response for a Team the user has already left must not replace the current list.
  let machinesRevision = 0
  let membersRevision = 0
  let machineDestination: { teamId: string; machineId: string; route: RouteLocationRaw } | undefined
  const resourceScope = () => JSON.stringify([account.value.serverUrl, account.value.user?.id, teamId.value])

  async function background(work: () => Promise<void>): Promise<void> {
    try { await work(); notice.value = undefined } catch (reason) { notice.value = message(reason) }
  }
  async function loadEnrollment(api = automatic): Promise<void> {
    localStatus.value = await api.localEnrollment?.().catch(() => undefined)
  }
  async function loadMembers(api = automatic): Promise<void> {
    const revision = ++membersRevision
    const selected = teamId.value
    const list = selected ? await api.members(selected) : []
    if (revision === membersRevision) members.value = list
  }
  async function loadMachines(preferred?: string, api = automatic): Promise<void> {
    const revision = ++machinesRevision
    const selected = teamId.value
    const list = selected ? await api.machines(selected) : []
    if (revision !== machinesRevision) return
    machines.value = list
    machineRosterVersion.value = revision
    // Keep the current machine; otherwise open this computer, then any reachable machine.
    const candidates = [preferred, machineId.value, localMachineId.value]
    machineId.value = candidates.find(id => list.some(value => value.id === id))
      ?? list.find(value => value.online)?.id ?? list[0]?.id
    if (machineDestination?.machineId !== machineId.value) machineDestination = undefined
  }
  function refreshMachines(): Promise<void> {
    return background(async () => { await loadEnrollment(); await loadMachines() })
  }
  async function reload(api = automatic): Promise<void> {
    account.value = await api.status()
    // Keep the last public site until a replacement arrives so focus refreshes do not
    // blank the title, announcement, or create-team controls while site() is in flight.
    const loadSite = api.site().then(value => { site.value = value })
    if (!account.value.user) {
      ++machinesRevision
      machineRosterVersion.value = undefined
      ++membersRevision
      teams.value = []; teamId.value = undefined; machines.value = []; machineId.value = undefined
      members.value = []
      dialog.value = undefined
      machineDestination = undefined
      searchPath.value = "/search"
      await loadSite
      return
    }
    const [list] = await Promise.all([api.teams(), loadEnrollment(api), loadSite])
    teams.value = list
    if (!list.some(value => value.id === teamId.value)) {
      searchPath.value = "/search"
      const registrations = localStatus.value?.registrations.filter(value => value.serverUrl === account.value.serverUrl) ?? []
      const enrolledTeam = (registrations.find(value => !value.revoked) ?? registrations[0])?.teamId
      teamId.value = (list.find(value => value.id === enrolledTeam) ?? list[0])?.id
      machineId.value = undefined
      members.value = []
      machineDestination = undefined
    }
    await Promise.all([loadMachines(undefined, api), loadMembers(api)])
  }
  async function selectTeam(id: string): Promise<void> {
    machineDestination = undefined
    if (id === teamId.value) return
    searchPath.value = "/search"
    teamId.value = id
    machineId.value = undefined
    machines.value = []
    members.value = []
    await background(async () => { await Promise.all([loadMachines(undefined, user), loadMembers(user)]) })
  }
  function openMachineRoute(targetMachineId: string, route: RouteLocationRaw): void {
    const selectedTeam = teamId.value
    if (!selectedTeam || !machines.value.some(value => value.id === targetMachineId && value.teamId === selectedTeam)) return
    if (targetMachineId === machineId.value) {
      // A second click can arrive while the newly selected surface is still mounting.
      if (machineDestination) machineDestination = { teamId: selectedTeam, machineId: targetMachineId, route }
      void router.push(route)
      return
    }
    machineDestination = { teamId: selectedTeam, machineId: targetMachineId, route }
    machineId.value = targetMachineId
  }
  function takeMachineDestination(targetMachineId: string): RouteLocationRaw | undefined {
    if (!machineDestination || targetMachineId !== machineId.value) return
    const destination = machineDestination
    machineDestination = undefined
    if (destination.teamId === teamId.value && destination.machineId === targetMachineId) return destination.route
  }
  function openSession(targetMachineId: string, sessionId: string): void {
    openMachineRoute(targetMachineId, { name: "session", params: { sessionId } })
  }
  function takeSessionDestination(targetMachineId: string): string | undefined {
    const destination = takeMachineDestination(targetMachineId)
    if (typeof destination !== "object" || !("name" in destination) || destination.name !== "session") return
    const sessionId = destination.params?.sessionId
    return typeof sessionId === "string" ? sessionId : undefined
  }
  async function enrollLocal(name?: string): Promise<void> {
    if (!user.enrollLocal || !teamId.value) throw new Error("This computer cannot be connected from this client")
    const selected = teamId.value, scope = resourceScope()
    const enrolled = await user.enrollLocal(selected, name)
    if (resourceScope() !== scope) return
    await loadEnrollment(user)
    if (resourceScope() !== scope) return
    await loadMachines(enrolled.machineId, user)
  }
  async function enrollHeadless(value: HeadlessMachine): Promise<{ machine: Machine; token: string }> {
    if (!teamId.value) throw new Error("Select a team first")
    const selected = teamId.value, scope = resourceScope()
    const result = await user.enrollHeadless(selected, value)
    if (resourceScope() === scope) await background(() => loadMachines(undefined, user))
    return result
  }
  // The open machine's own catalog follows through the server's change notification.
  async function renameMachine(id: string, name: string): Promise<void> {
    const selected = teamId.value!, scope = resourceScope()
    const renamed = await user.renameMachine(selected, id, name)
    if (resourceScope() !== scope) return
    machines.value = machines.value.map(value => value.id === id && value.teamId === selected ? { ...value, name: renamed.name } : value)
  }
  async function removeMachine(id: string): Promise<void> {
    const selected = teamId.value!, scope = resourceScope()
    await user.removeMachine(selected, id)
    if (resourceScope() !== scope) return
    if (machineId.value === id) machineId.value = undefined
    await Promise.all([loadEnrollment(user), loadMachines(undefined, user)])
  }
  function openSettings(section: AccountSettingsSection): void {
    const name = section === "team" ? "team-settings" : section === "plans" ? "team-settings-plans" : `settings-${section}`
    void router.push({ name })
  }

  const unsubscribe = central.onEvent(event => {
    if (event.type === "accountChanged") void background(reload)
    else if (event.type === "connection") {
      // A response started before this connection change cannot repair missed presence.
      ++machinesRevision
      machineRosterVersion.value = undefined
      connected.value = event.connected
      if (event.connected) void background(reload)
    } else if (event.type === "machinesChanged" && event.teamId === teamId.value) void refreshMachines()
    else if (event.type === "presence" && event.teamId === teamId.value) {
      const target = machines.value.find(value => value.id === event.machineId)
      if (target) target.online = event.online
    }
  })
  void background(reload).finally(() => { ready.value = true; if (initialNotice) notice.value = initialNotice })

  return {
    central, ready, account, site, teams, teamId, team, members, machines, machineRosterVersion, machineId, machine, searchPath, localStatus, enrollment, localMachineId, canEnrollLocal,
    connected, notice, dialog, reload,
    refreshMachines,
    async signIn() { await user.login(); await reload(user) },
    async signOut() {
      machineDestination = undefined
      await user.logout()
      account.value = { serverUrl: account.value.serverUrl, siteAdmin: false }
      await reload(user)
    },
    selectTeam,
    selectMachine(id) { machineDestination = undefined; if (machines.value.some(value => value.id === id)) machineId.value = id },
    openMachineRoute, takeMachineDestination, openSession, takeSessionDestination,
    async createTeam(name) {
      const created = await user.createTeam(name)
      teams.value = [...teams.value, created]
      await selectTeam(created.id)
    },
    async joinTeam(code) {
      const track = captureAnalyticsContext()
      track("team_join_action", { outcome: "attempt" })
      let joined: Team
      try {
        joined = await user.acceptInvite(code)
        track("team_join_action", { outcome: "success" })
      } catch (reason) {
        track("team_join_action", { outcome: "failure" })
        throw reason
      }
      teams.value = await user.teams()
      await selectTeam(joined.id)
    },
    async renameTeam(name) {
      if (!teamId.value) return
      const renamed = await user.renameTeam(teamId.value, name)
      teams.value = teams.value.map(value => value.id === renamed.id ? { ...value, name: renamed.name } : value)
    },
    enrollLocal, enrollHeadless, renameMachine, removeMachine, openSettings,
    dispose: unsubscribe,
  }
}
