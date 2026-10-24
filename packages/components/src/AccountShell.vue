<script setup lang="ts">
import { computed, createApp, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, vaporInteropPlugin, type App as VueApp } from "vue"
import { createPinia, disposePinia } from "pinia"
import { useI18n } from "vue-i18n"
import type { AccountState, LocalEnrollment, Machine, Team } from "@deskfleet/client/central"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import { configureClient } from "@deskfleet/client/platform"
import { remoteMachineClient } from "@deskfleet/client/remote"
import App from "./App.vue"
import EnrollMachine from "./components/settings/EnrollMachine.vue"
import TeamSettings from "./components/settings/TeamSettings.vue"
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
const teamName = ref("")
const teamSettings = ref(false)
const creatingTeam = ref(false)
const joining = ref(false)
const enrollingHeadless = ref(false)
const inviteCode = ref("")
const team = computed(() => teams.value.find(value => value.id === teamId.value))
const enrollment = ref<LocalEnrollment>()
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
  if (!account.value.user) { release(); teams.value = []; machines.value = []; return }
  teams.value = await central.teams()
  if (!teams.value.some(team => team.id === teamId.value)) teamId.value = teams.value[0]?.id ?? ""
  enrollment.value = await central.localEnrollment?.().catch(() => undefined)
  await loadMachines()
}
async function loadMachines(): Promise<void> {
  machines.value = teamId.value ? await central.machines(teamId.value) : []
  if (!machines.value.some(item => item.id === machineId.value)) { machineId.value = machines.value[0]?.id ?? ""; await selectMachine() }
}
async function selectTeam(): Promise<void> { release(); machineId.value = ""; await action(loadMachines) }
async function selectMachine(): Promise<void> {
  release()
  if (!machine.value) return
  const current = generation
  await nextTick()
  if (current !== generation || !surface.value) return
  await router.replace("/")
  remote = remoteMachineClient(props.host, central, machine.value)
  configureClient(remote.api)
  workspaceState = createPinia()
  workspace = createApp(App).use(workspaceState).use(router).use(i18n)
  if (vaporInteropPlugin) workspace.use(vaporInteropPlugin)
  workspace.mount(surface.value)
}
async function login(): Promise<void> {
  await action(async () => { await central.setServer(serverUrl.value); await central.login(); await load() })
}
async function createTeam(): Promise<void> {
  await action(async () => { const team = await central.createTeam(teamName.value.trim()); teamName.value = ""; creatingTeam.value = false; teams.value.push(team); teamId.value = team.id; await selectTeam() })
}
async function acceptInvite(): Promise<void> { await action(async () => { const joined = await central.acceptInvite(inviteCode.value.trim()); inviteCode.value = ""; joining.value = false; teamId.value = joined.id; await load() }) }
async function enroll(): Promise<void> {
  await action(async () => { enrollment.value = await central.enrollLocal!(teamId.value); await loadMachines() })
}
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
  <div class="flex h-full flex-col bg-ui-canvas text-ui-text">
    <header class="app-no-drag flex shrink-0 flex-wrap items-center gap-3 border-b border-ui-border px-4 py-3" :class="host.platform === 'darwin' && 'pl-20'">
      <span class="font-semibold">deskfleet</span>
      <template v-if="account.user">
        <select v-model="teamId" :aria-label="t('account.team')" class="catalog-input !w-auto" :disabled="busy" @change="selectTeam">
          <option v-for="team in teams" :key="team.id" :value="team.id">{{ team.name }}</option>
        </select>
        <select v-model="machineId" :aria-label="t('account.machine')" class="catalog-input !w-auto" :disabled="busy" @change="selectMachine">
          <option value="" disabled>{{ t('account.chooseMachine') }}</option>
          <option v-for="item in machines" :key="item.id" :value="item.id">{{ item.name }}{{ item.online ? '' : ` · ${t('machine.offline')}` }}</option>
        </select>
        <button class="catalog-button" :disabled="busy" @click="creatingTeam = !creatingTeam">{{ t('account.createTeam') }}</button>
        <button v-if="team?.role === 'admin'" class="catalog-button" :disabled="busy" @click="enrollingHeadless = true">{{ t('account.enrollHeadless') }}</button>
        <button v-if="team" class="catalog-button" :disabled="busy" @click="teamSettings = true">{{ t('account.teamSettings') }}</button>
        <button class="catalog-button" :disabled="busy" @click="joining = !joining">{{ t('account.joinTeam') }}</button>
        <button class="catalog-button" :disabled="busy" @click="action(loadMachines)">{{ t('catalog.refresh') }}</button>
        <button v-if="central.enrollLocal && enrollment && !enrollment.configured && team?.role === 'admin'" class="catalog-button" :disabled="busy" @click="enroll">{{ t('account.enrollThisMachine') }}</button>
        <span class="ml-auto text-xs text-ui-text-muted">{{ account.user.name }}</span>
        <button class="catalog-button" :disabled="busy" @click="action(async () => { await central.logout(); await load() })">{{ t('account.signOut') }}</button>
      </template>
    </header>
    <EnrollMachine v-if="enrollingHeadless && team" :central="central" :team-id="team.id" :server-url="account.serverUrl" @close="enrollingHeadless = false" @enrolled="action(loadMachines)" />
    <TeamSettings v-if="teamSettings && team && account.user" :central="central" :team="team" :user-id="account.user.id" @close="teamSettings = false" @changed="action(load)" />
    <form v-if="creatingTeam && teams.length" class="flex gap-2 border-b border-ui-border p-3" @submit.prevent="createTeam"><input v-model="teamName" class="catalog-input" :aria-label="t('account.teamName')" :placeholder="t('account.teamName')" required /><button class="catalog-button shrink-0" :disabled="busy">{{ t('catalog.create') }}</button></form>
    <form v-if="joining" class="flex gap-2 border-b border-ui-border p-3" @submit.prevent="acceptInvite"><input v-model="inviteCode" class="catalog-input" :aria-label="t('account.inviteCode')" :placeholder="t('account.inviteCode')" required /><button class="catalog-button shrink-0" :disabled="busy">{{ t('account.joinTeam') }}</button></form>
    <p v-if="error" role="alert" class="m-0 border-b border-ui-border px-4 py-2 text-sm text-ui-danger">{{ error }}</p>
    <p v-if="account.user && !connected" role="status" class="m-0 px-4 py-2 text-sm text-ui-warning">{{ t('account.signalingOffline') }}</p>
    <div v-if="!account.user" class="flex flex-1 items-center justify-center p-6">
      <form class="ui-card flex w-full max-w-md flex-col gap-4 p-6" @submit.prevent="login">
        <h1 class="m-0 text-xl font-semibold">{{ t('account.signIn') }}</h1>
        <label class="flex flex-col gap-2 text-sm">{{ t('account.server') }}<input v-model="serverUrl" type="url" class="catalog-input" required :disabled="busy" placeholder="https://deskfleet.example.com" /></label>
        <button class="catalog-button" type="submit" :disabled="busy">{{ busy ? t('settings.loading') : t('account.continueOidc') }}</button>
      </form>
    </div>
    <div v-else-if="!machineId" class="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-4 p-6">
      <h1 class="m-0 text-xl font-semibold">{{ teams.length ? t('account.addMachine') : t('account.createTeam') }}</h1>
      <form v-if="!teams.length" class="flex gap-2" @submit.prevent="createTeam">
        <input v-model="teamName" class="catalog-input" :placeholder="t('account.teamName')" required />
        <button class="catalog-button shrink-0" :disabled="busy">{{ t('catalog.create') }}</button>
      </form>
      <template v-else-if="central.enrollLocal && team?.role === 'admin'">
        <p v-if="enrollment?.configured" class="text-sm text-ui-text-muted">{{ t('account.alreadyEnrolled', { server: enrollment.serverUrl ?? '', team: enrollment.teamId ?? '' }) }}</p>
        <button v-else class="catalog-button" :disabled="busy" @click="enroll">{{ t('account.enrollThisMachine') }}</button>
      </template>
      <p v-else class="text-sm text-ui-text-muted">{{ t('account.headlessEnrollment') }}</p>
    </div>
    <div v-show="account.user && machineId" ref="surface" class="min-h-0 flex-1" />
  </div>
</template>
