<script setup lang="ts">
import { computed, createApp, nextTick, onBeforeUnmount, onMounted, provide, ref, shallowRef, vaporInteropPlugin, type App as VueApp } from "vue"
import { ArrowLeft, Monitor, Plus, Users } from "@lucide/vue"
import { createPinia, disposePinia } from "pinia"
import { useI18n } from "vue-i18n"
import type { AccountState, LocalEnrollment, Machine, Team } from "@deskfleet/client/central"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import { configureClient } from "@deskfleet/client/platform"
import { remoteMachineClient } from "@deskfleet/client/remote"
import App from "./App.vue"
import EnrollMachine from "./components/settings/EnrollMachine.vue"
import TeamSettings from "./components/settings/TeamSettings.vue"
import TeamAccessDialog from "./components/settings/TeamAccessDialog.vue"
import AccountSwitcher from "./components/sidebar/AccountSwitcher.vue"
import AccountMenu from "./components/sidebar/AccountMenu.vue"
import { accountContextKey, type AccountContext } from "./composables/useAccountContext.ts"
import { i18n } from "./i18n/index.ts"
import { router } from "./router/index.ts"

const props = defineProps<{ host: DeskfleetDesktopApi }>()
const central = props.host.central!
const { t } = useI18n()
const account = ref<AccountState>({ serverUrl: "" })
const serverUrl = ref("")
const teams = ref<Team[]>([])
const teamId = ref("")
const machines = ref<Machine[]>([])
const machineId = ref("")
const teamSettings = ref(false)
const teamDialog = ref<"create" | "join">()
const enrollingHeadless = ref(false)
const team = computed(() => teams.value.find(value => value.id === teamId.value))
const enrollment = ref<LocalEnrollment>()
const canEnroll = computed(() => !!enrollment.value && (!enrollment.value.configured || enrollment.value.revoked))
const busy = ref(false)
const error = ref<string>()
const connected = ref(true)
const surface = shallowRef<HTMLElement>()
const machine = computed(() => machines.value.find(item => item.id === machineId.value))
let workspace: VueApp | undefined
let workspaceState: ReturnType<typeof createPinia> | undefined
let remote: ReturnType<typeof remoteMachineClient> | undefined
let generation = 0
function release(): void { ++generation; workspace?.unmount(); workspace = undefined; if (workspaceState) disposePinia(workspaceState); workspaceState = undefined; remote?.dispose(); remote = undefined; configureClient(props.host) }
async function action(work: () => Promise<void>): Promise<void> {
  busy.value = true; error.value = undefined
  try { await work() } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
async function load(): Promise<void> {
  account.value = await central.status(); serverUrl.value = account.value.serverUrl
  if (!account.value.user) { release(); teams.value = []; machines.value = []; teamId.value = ""; machineId.value = ""; teamSettings.value = false; return }
  teams.value = await central.teams()
  enrollment.value = await central.localEnrollment?.().catch(() => undefined)
  if (!teams.value.some(team => team.id === teamId.value)) {
    const previousTeam = enrollment.value?.serverUrl === account.value.serverUrl ? enrollment.value.teamId : undefined
    teamId.value = teams.value.find(team => team.id === previousTeam)?.id ?? teams.value[0]?.id ?? ""
  }
  await loadMachines()
}
async function refresh(): Promise<void> {
  enrollment.value = await central.localEnrollment?.().catch(() => undefined)
  await loadMachines()
}
async function loadMachines(): Promise<void> {
  machines.value = teamId.value ? await central.machines(teamId.value) : []
  if (!machines.value.some(item => item.id === machineId.value)) { machineId.value = machines.value[0]?.id ?? ""; await selectMachine() }
}
async function selectTeam(): Promise<void> { release(); teamSettings.value = false; machineId.value = ""; await action(loadMachines) }
async function selectMachine(): Promise<void> {
  release()
  teamSettings.value = false
  const selected = machine.value
  if (!selected) return
  const current = generation
  await nextTick()
  if (current !== generation || !surface.value) return
  await router.replace("/")
  if (current !== generation || !surface.value) return
  remote = remoteMachineClient(props.host, central, selected)
  configureClient(remote.api)
  workspaceState = createPinia()
  workspace = createApp(App).provide(accountContextKey, context).use(workspaceState).use(router).use(i18n)
  if (vaporInteropPlugin) workspace.use(vaporInteropPlugin)
  workspace.mount(surface.value)
}
async function login(): Promise<void> {
  await action(async () => { await central.setServer(serverUrl.value); await central.login(); await load() })
}
async function createTeam(name: string): Promise<void> {
  await action(async () => { const team = await central.createTeam(name); teamDialog.value = undefined; teams.value.push(team); teamId.value = team.id; await selectTeam() })
}
async function acceptInvite(code: string): Promise<void> { await action(async () => { const joined = await central.acceptInvite(code); teamDialog.value = undefined; release(); machineId.value = ""; teamId.value = joined.id; await load() }) }
async function enroll(): Promise<void> {
  await action(async () => { enrollment.value = await central.enrollLocal!(teamId.value); await loadMachines() })
}
function openTeamDialog(mode: "create" | "join"): void { error.value = undefined; teamDialog.value = mode }
const context: AccountContext = {
  central, account, teams, team, teamId, machines, machineId, enrollment, canEnroll, busy, error, connected,
  selectTeam: async id => { if (teamId.value !== id) { teamId.value = id; await selectTeam() } },
  selectMachine: async id => { if (machineId.value !== id) { machineId.value = id; await action(selectMachine) } },
  createTeam: () => openTeamDialog("create"), joinTeam: () => openTeamDialog("join"),
  manageTeam: () => { if (machineId.value) void router.push({ name: "settings-team" }); else teamSettings.value = true },
  enrollHeadless: () => { enrollingHeadless.value = true }, enrollLocal: enroll,
  refresh: () => action(refresh), reload: () => action(load),
  logout: () => action(async () => { await central.logout(); await load() }),
}
provide(accountContextKey, context)
const unsubscribe = central.onEvent(event => {
  if (event.type === "accountChanged") void action(load)
  if (event.type === "connection") connected.value = event.connected
  if (event.type === "presence") {
    const target = machines.value.find(item => item.id === event.machineId)
    if (target) target.online = event.online
  }
})
onMounted(() => { void action(async () => { await load(); if (props.host.initialError) error.value = props.host.initialError }) })
onBeforeUnmount(() => { unsubscribe(); release() })
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-ui-canvas text-ui-text">
    <EnrollMachine v-if="enrollingHeadless && team" :central="central" :team-id="team.id" :server-url="account.serverUrl" @close="enrollingHeadless = false" @enrolled="action(loadMachines)" />
    <TeamAccessDialog v-if="teamDialog" :mode="teamDialog" :busy="busy" :error="error" @close="teamDialog = undefined" @submit="teamDialog === 'create' ? createTeam($event) : acceptInvite($event)" />
    <template v-if="!account.user">
      <div class="app-drag titlebar-overlay-inset flex h-12 shrink-0 items-center px-5 text-[13px] font-medium" :class="host.platform === 'darwin' && 'pl-20'">deskfleet</div>
      <div class="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
        <form class="flex w-full max-w-sm flex-col gap-5" @submit.prevent="login">
          <div><h1 class="m-0 text-xl font-semibold">{{ t('account.signIn') }}</h1><p class="mb-0 mt-2 text-sm text-ui-text-muted">deskfleet</p></div>
          <label class="flex flex-col gap-2 text-[13px] text-ui-text-muted">{{ t('account.server') }}<input v-model="serverUrl" type="url" class="catalog-input text-ui-text" required :disabled="busy" placeholder="https://deskfleet.example.com" /></label>
          <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
          <button class="catalog-button justify-center" type="submit" :disabled="busy">{{ busy ? t('settings.loading') : t('account.continueOidc') }}</button>
        </form>
      </div>
    </template>
    <div v-else-if="!machineId" class="flex min-h-0 flex-1">
      <aside class="flex w-65 shrink-0 flex-col border-r border-ui-border bg-ui-sidebar">
        <div class="app-drag h-12 shrink-0" />
        <AccountSwitcher />
        <div class="flex-1" />
        <footer class="flex h-12 shrink-0 items-center border-t border-ui-border px-2"><AccountMenu /></footer>
      </aside>
      <main class="flex min-w-0 flex-1 flex-col">
        <div class="app-drag titlebar-overlay-inset flex h-12 shrink-0 items-center px-5">
          <button v-if="teamSettings" type="button" class="ui-text-button cursor-pointer hover:bg-ui-hover" @click="teamSettings = false"><ArrowLeft :size="16" aria-hidden="true" />{{ t('settings.back') }}</button>
        </div>
        <div v-if="teamSettings && team && account.user" class="min-h-0 flex-1 overflow-y-auto px-14 pb-10"><div class="mx-auto max-w-3xl"><TeamSettings :central="central" :team="team" :user-id="account.user.id" @changed="action(load)" /></div></div>
        <div v-else class="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-6 pb-12 text-center">
          <component :is="teams.length ? Monitor : Users" :size="32" :stroke-width="1.5" class="text-ui-text-faint" aria-hidden="true" />
          <h1 class="m-0 text-lg font-semibold">{{ t(teams.length ? 'account.addMachine' : 'account.createTeam') }}</h1>
          <template v-if="!teams.length">
            <button type="button" class="catalog-button" :disabled="busy" @click="openTeamDialog('create')"><Plus :size="15" aria-hidden="true" />{{ t('account.createTeam') }}</button>
            <button type="button" class="ui-text-button cursor-pointer hover:bg-ui-hover" :disabled="busy" @click="openTeamDialog('join')">{{ t('account.joinTeam') }}</button>
          </template>
          <template v-else>
            <p class="m-0 text-sm leading-relaxed text-ui-text-muted">{{ t('account.machineSetupDescription') }}</p>
            <template v-if="central.enrollLocal">
              <p v-if="enrollment?.configured && !enrollment.revoked" class="m-0 text-[13px] text-ui-text-muted">{{ t('account.alreadyEnrolled', { server: enrollment.serverUrl ?? '', team: enrollment.teamId ?? '' }) }}</p>
              <button v-else-if="canEnroll" type="button" class="catalog-button" :disabled="busy" @click="enroll">{{ t(enrollment?.revoked ? 'account.reenrollThisMachine' : 'account.enrollThisMachine') }}</button>
            </template>
            <button type="button" class="catalog-button" :disabled="busy" @click="enrollingHeadless = true"><Plus :size="15" aria-hidden="true" />{{ t('account.enrollHeadless') }}</button>
          </template>
        </div>
      </main>
    </div>
    <div v-show="account.user && machineId" ref="surface" class="min-h-0 flex-1" />
  </div>
</template>
