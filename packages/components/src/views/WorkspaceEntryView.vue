<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from "vue"
import { useRoute } from "vue-router"
import { useI18n } from "vue-i18n"
import UiButton from "../components/common/UiButton.vue"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import { useAccountSession } from "../composables/useAccountSession.ts"
import { usePlatformClient } from "../composables/usePlatformClient.ts"
import NewSessionView from "./NewSessionView.vue"
import WorkspaceAgentSetupView from "./WorkspaceAgentSetupView.vue"
const WorkspaceAgentView = defineAsyncComponent(() => import("./WorkspaceAgentView.vue"))
const NewProjectView = defineAsyncComponent(() => import("./NewProjectView.vue"))

const props = defineProps<{ workspaceId?: string; createProject?: boolean }>()
const client = usePlatformClient()
const account = useAccountSession()
const route = useRoute()
const { t } = useI18n()
const desktopHome = !!client.localChannels && !!account
const machine = computed(() => typeof route.query.machine === "string" ? route.query.machine : undefined)
const missing = computed(() => !!account && !!machine.value && (
  (typeof route.query.team === "string" && route.query.team !== account.teamId.value)
  || !account.machines.value.some(item => item.id === machine.value)
))
const machineMatches = computed(() => !machine.value || machine.value === client.target?.id || (!account && machine.value === "local-daemon" && !client.target))
const scoped = computed(() => !!machine.value || !!props.workspaceId || !!props.createProject)
const localHome = computed(() => {
  if (scoped.value || !desktopHome || !account) return
  const id = account.localMachineId.value
  return id && account.machines.value.some(item => item.id === id) ? id : undefined
})
const switchTo = computed(() => {
  if (!account || missing.value) return
  const id = machine.value ?? localHome.value
  if (id && id !== account.machineId.value) return id
})
watch(switchTo, id => {
  if (id) account!.openMachineRoute(id, scoped.value ? route.fullPath : { name: "new-session" })
}, { immediate: true })
// Keep the live conversation, including drafts, mounted if this machine drops offline.
const openedWorkspace = ref<string>()
const workspaceKey = computed(() => JSON.stringify([client.target?.id, props.workspaceId ?? null]))
const offline = computed(() => !!client.remoteWorkspaceAgent && account?.machine.value?.online === false
  && (props.createProject || openedWorkspace.value !== workspaceKey.value))
watch(() => [workspaceKey.value, account?.machine.value?.online, !!client.superAgent] as const, ([key, online, capable]) => {
  if (online && capable) openedWorkspace.value = key
}, { immediate: true })
const checking = ref(false)
async function checkAgain() {
  if (!account || checking.value) return
  checking.value = true
  try { await account.refreshMachines() }
  finally { checking.value = false }
}
</script>

<template>
  <template v-if="missing">
    <PaneHeader />
    <p role="alert" class="m-auto px-6 text-sm text-ui-text-muted">{{ t("superAgent.machineNav.missing") }}</p>
  </template>
  <template v-else-if="!switchTo && machineMatches">
    <template v-if="desktopHome && !scoped && !localHome">
      <PaneHeader />
      <WorkspaceAgentSetupView />
    </template>
    <template v-else-if="offline">
      <PaneHeader />
      <section data-agent-offline class="m-auto flex flex-col items-center gap-3 px-6 text-center">
        <p role="status" class="m-0">{{ t("superAgent.machineNav.reconnect", { machine: account?.machine.value?.name }) }}</p>
        <UiButton :loading="checking" @click="checkAgain">{{ t("superAgent.setup.checkAgain") }}</UiButton>
      </section>
    </template>
    <NewProjectView v-else-if="createProject && (desktopHome || client.superAgent)" />
    <WorkspaceAgentView v-else-if="client.superAgent" :key="JSON.stringify(workspaceId ?? null)" :api="client.superAgent" :workspace-id="workspaceId ?? null" />
    <template v-else-if="desktopHome || client.remoteWorkspaceAgent">
      <PaneHeader v-if="client.remoteWorkspaceAgent" />
      <section data-agent-upgrade class="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 class="m-0 text-xl font-semibold">{{ t("superAgent.machineNav.unsupported", { machine: account?.machine.value?.name }) }}</h1>
        <p class="m-0 text-sm leading-relaxed text-ui-text-muted">{{ t("superAgent.machineNav.upgrade", { machine: account?.machine.value?.name }) }}</p>
        <UiButton :loading="checking" @click="checkAgain">{{ t("superAgent.setup.checkAgain") }}</UiButton>
      </section>
    </template>
    <NewSessionView v-else />
  </template>
</template>
