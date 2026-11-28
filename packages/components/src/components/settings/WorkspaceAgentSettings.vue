<script setup lang="ts">
import { computed, onBeforeUnmount, onScopeDispose, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { FollowUpAuthSummary, SuperHistoryGroup } from "@deskfleet/protocol/super-agent"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useMachineRuntimes } from "../../composables/useMachineRuntimes.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import {
  MAX_WORKSPACE_AGENT_DISPLAY_NAME_LENGTH,
  normalizeWorkspaceAgentDisplayName,
  useWorkspaceAgentDisplayName,
} from "../../composables/useWorkspaceAgentDisplayName.ts"
import {
  disableTakeoverOnMachine, enableTakeoverOnMachine, hasPendingFollowUpRevocation, listPendingRevocationsForAccount,
  revokeAllScopesForInstallation, syncAndFlushPendingRevocation,
  type FollowUpScope,
} from "../../services/workspace-agent-follow-up.ts"
import { createFollowUpMachineResolver } from "../../services/workspace-agent-follow-up-resolver.ts"
import { projectDirectoryName, useWorkspaceAgentMode } from "../../services/workspace-agent-navigation.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import UiButton from "../common/UiButton.vue"
import UiSelect from "../common/UiSelect.vue"
import UiSwitch from "../common/UiSwitch.vue"
import SettingsRow from "./SettingsRow.vue"

const { t } = useI18n()
const enabled = useWorkspaceAgentMode()
const { customName: savedDisplayName } = useWorkspaceAgentDisplayName(() => t("superAgent.role.assistant"))
const displayNameDraft = ref(savedDisplayName.value)
let displayNameComposing = false

watch(savedDisplayName, next => {
  if (normalizeWorkspaceAgentDisplayName(displayNameDraft.value) !== next) {
    displayNameDraft.value = next
  }
})

function syncDisplayName(): void {
  savedDisplayName.value = displayNameDraft.value
}

function onDisplayNameInput(): void {
  if (!displayNameComposing) syncDisplayName()
}

function onDisplayNameCompositionEnd(): void {
  displayNameComposing = false
  syncDisplayName()
}

function commitDisplayName(): void {
  displayNameComposing = false
  syncDisplayName()
  displayNameDraft.value = savedDisplayName.value
}

function onDisplayNameEnter(event: KeyboardEvent): void {
  if (event.isComposing || displayNameComposing) return
  event.preventDefault()
  commitDisplayName()
}

onBeforeUnmount(() => {
  if (normalizeWorkspaceAgentDisplayName(displayNameDraft.value) !== savedDisplayName.value) {
    syncDisplayName()
  }
})

const client = usePlatformClient()
const account = useAccountSession()
const runtimes = useMachineRuntimes()
const fleet = useFleetStore()
const groups = ref<SuperHistoryGroup[]>()
const selected = ref<Record<string, string>>({})
const busy = ref(false)
const error = ref("")
const followUpBusy = ref(false)
const followUpNotice = ref("")
const followUpError = ref("")
const followUpSummary = ref<FollowUpAuthSummary>()
const hostSupportsFollowUp = ref(false)
const followUpChecked = ref(false)
const pendingRevocation = ref(false)
let revision = 0

const machineName = computed(() => account?.machine.value?.name ?? fleet.localDesktopTarget.name)
const takeoverActive = computed(() => !!followUpSummary.value?.authorized && followUpSummary.value?.takeoverAllSessions === true)
const scope = computed<FollowUpScope>(() => ({
  serverUrl: account?.account.value.serverUrl,
  userId: account?.account.value.user?.id,
  teamId: account?.teamId.value,
  machineId: fleet.targetId,
}))
const syncPendingFlag = () => {
  pendingRevocation.value = hasPendingFollowUpRevocation(scope.value)
    || listPendingRevocationsForAccount(scope.value.serverUrl, scope.value.userId).length > 0
}

async function refreshFollowUp() {
  syncPendingFlag()
  if (!client.superAgent?.followUpAuth) {
    hostSupportsFollowUp.value = false
    followUpChecked.value = true
    followUpSummary.value = undefined
    return
  }
  const current = ++revision
  try {
    const receipt = await syncAndFlushPendingRevocation(client.superAgent, scope.value)
    if (revision !== current) return
    hostSupportsFollowUp.value = true
    followUpChecked.value = true
    syncPendingFlag()
    followUpSummary.value = receipt?.summary
  } catch {
    if (revision !== current) return
    // Older daemon that does not recognize followUpAuth degrades gracefully.
    hostSupportsFollowUp.value = false
    followUpChecked.value = true
    syncPendingFlag()
  }
}

watch(enabled, async (next, prev) => {
  ++revision
  groups.value = undefined
  selected.value = {}
  error.value = ""
  busy.value = false
  followUpError.value = ""
  followUpNotice.value = ""
  displayNameComposing = false
  displayNameDraft.value = savedDisplayName.value
  if (prev === true && next === false) {
    const hasKnownGrants = listPendingRevocationsForAccount(scope.value.serverUrl, scope.value.userId).length > 0 || !!client.superAgent?.followUpAuth
    if (hasKnownGrants || account?.account.value.user?.id) {
      followUpBusy.value = true
      try {
        const resolveApi = createFollowUpMachineResolver({
          host: client,
          session: account,
          runtimes,
          fallback: { machineId: scope.value.machineId, teamId: scope.value.teamId, api: client.superAgent },
        })
        const extraScopes: FollowUpScope[] = client.superAgent?.followUpAuth ? [scope.value] : []
        const outcome = await revokeAllScopesForInstallation({
          serverUrl: scope.value.serverUrl,
          userId: scope.value.userId,
          resolveApi,
          extraScopes,
          info: { platform: client.platform, deviceLabel: client.platform },
        })
        syncPendingFlag()
        const currentResult = outcome.results.find(item => item.scope.machineId === scope.value.machineId && item.scope.teamId === scope.value.teamId)
        if (currentResult?.confirmed && currentResult.receipt) {
          followUpSummary.value = currentResult.receipt.summary
        }
        if (outcome.results.length) {
          if (!outcome.allConfirmed) {
            followUpNotice.value = t("superAgent.followUp.pendingRevocation", { machine: machineName.value })
          } else if (outcome.anyOtherDeviceActive) {
            followUpNotice.value = t("superAgent.followUp.otherDevicesActive", { machine: machineName.value, count: outcome.maxOtherActiveDevices }, outcome.maxOtherActiveDevices)
          } else {
            followUpNotice.value = t("superAgent.followUp.stopped", { machine: machineName.value })
          }
        }
      } finally { followUpBusy.value = false }
    }
    return
  }
  if (next === true) {
    void refreshFollowUp()
  }
}, { flush: "sync" })

watch(() => [scope.value.userId, scope.value.teamId, scope.value.machineId], () => {
  followUpSummary.value = undefined
  followUpNotice.value = ""
  followUpError.value = ""
  syncPendingFlag()
  void refreshFollowUp()
}, { immediate: true })

onScopeDispose(() => { ++revision })

async function toggleTakeoverAll(nextEnabled: boolean) {
  if (followUpBusy.value || !client.superAgent?.followUpAuth) return
  followUpBusy.value = true
  followUpError.value = ""
  followUpNotice.value = ""
  try {
    if (nextEnabled) {
      const receipt = await enableTakeoverOnMachine(client.superAgent, scope.value, {
        platform: client.platform,
        deviceLabel: client.platform,
        machineName: machineName.value,
      })
      syncPendingFlag()
      followUpSummary.value = receipt.summary
      if (receipt.status === "stale_ignored" || !receipt.authorized || receipt.summary?.takeoverAllSessions !== true) {
        followUpError.value = t("superAgent.followUp.takeoverAllAuthFailed")
      }
    } else {
      const receipt = await disableTakeoverOnMachine(client.superAgent, scope.value)
      syncPendingFlag()
      followUpSummary.value = receipt.summary
      followUpNotice.value = t("superAgent.followUp.takeoverAllStopped", { machine: machineName.value })
    }
  } catch (reason) {
    followUpError.value = reason instanceof Error ? reason.message : String(reason)
  } finally { followUpBusy.value = false }
}

const key = (group: SuperHistoryGroup) => JSON.stringify(group.paths)
function choice(group: SuperHistoryGroup) {
  const id = selected.value[key(group)]
  return group.projects.some(project => project.id === id) ? id! : group.projects.length === 1 ? group.projects[0]!.id : ""
}
async function organize(group?: SuperHistoryGroup) {
  if (busy.value || !enabled.value || !client.superAgent?.history) return
  const current = ++revision
  error.value = ""
  busy.value = true
  try {
    let assign
    if (group) {
      let workspaceId = choice(group)
      if (!workspaceId && !group.projects.length) {
        if (!fleet.canManageCatalog) await fleet.refreshLocal()
        if (revision !== current) return
        const workspace = await fleet.createWorkspace(projectDirectoryName(group.paths[0]!), group.paths.map(path => ({ path })))
        workspaceId = workspace.id
        selected.value[key(group)] = workspaceId
        group.projects = [{ id: workspaceId, name: workspace.name }]
      }
      if (!workspaceId || revision !== current) return
      assign = { workspaceId, sessionIds: group.sessionIds }
    }
    const result = await client.superAgent.history({ view: "groups", assign })
    if (revision !== current) return
    fleet.setHistoryLinks(result.links)
    groups.value = result.groups ?? []
  } catch (reason) {
    if (revision === current) error.value = reason instanceof Error ? reason.message : String(reason)
  } finally { if (revision === current) busy.value = false }
}
</script>

<template>
  <section class="mb-6" aria-labelledby="workspace-agent-heading">
    <h2 id="workspace-agent-heading" class="ui-section-title mb-2">{{ t("superAgent.mode.heading") }}</h2>
    <div class="ui-card">
      <SettingsRow :label="t('superAgent.mode.label')" label-id="workspace-agent-mode" description-id="workspace-agent-description">
        <template #description>{{ t("superAgent.mode.description") }}</template>
        <UiSwitch v-model="enabled" aria-labelledby="workspace-agent-mode" aria-describedby="workspace-agent-description" name="super-agent-mode" />
      </SettingsRow>
      <p v-if="!enabled && pendingRevocation" role="status" class="mx-4 mb-3 text-sm text-ui-text-muted">{{ t("superAgent.followUp.pendingRevocation", { machine: machineName }) }}</p>
      <p v-else-if="followUpNotice" role="status" class="mx-4 mb-3 text-sm text-ui-text-muted">{{ followUpNotice }}</p>
      <SettingsRow v-if="enabled" :label="t('superAgent.mode.displayName')" label-id="workspace-agent-display-name" description-id="workspace-agent-display-name-description">
        <template #description>{{ t("superAgent.mode.displayNameDescription") }}</template>
        <input
          v-model="displayNameDraft"
          type="text"
          name="super-agent-display-name"
          data-super-agent-display-name
          class="ui-input w-56 max-w-full"
          :placeholder="t('superAgent.role.assistant')"
          :maxlength="MAX_WORKSPACE_AGENT_DISPLAY_NAME_LENGTH"
          autocomplete="off"
          aria-labelledby="workspace-agent-display-name"
          aria-describedby="workspace-agent-display-name-description"
          @compositionstart="displayNameComposing = true"
          @compositionend="onDisplayNameCompositionEnd"
          @input="onDisplayNameInput"
          @change="commitDisplayName"
          @blur="commitDisplayName"
          @keydown.enter="onDisplayNameEnter"
        >
      </SettingsRow>
      <template v-if="enabled && client.superAgent?.followUpAuth && hostSupportsFollowUp">
        <SettingsRow :label="t('superAgent.followUp.takeoverAllLabel')" label-id="workspace-takeover-all" description-id="workspace-takeover-all-description">
          <template #description>
            <template v-if="takeoverActive">{{ t("superAgent.followUp.takeoverAllActive", { machine: machineName }) }}</template>
            <template v-else>{{ t("superAgent.followUp.takeoverAllDescription", { machine: machineName }) }}</template>
          </template>
          <UiSwitch
            :model-value="takeoverActive"
            data-follow-up-takeover-all
            aria-labelledby="workspace-takeover-all"
            aria-describedby="workspace-takeover-all-description"
            name="super-agent-takeover-all"
            :disabled="followUpBusy"
            @update:model-value="toggleTakeoverAll"
          />
        </SettingsRow>
        <p v-if="followUpError" role="alert" class="mx-4 mb-3 text-sm text-ui-danger">{{ followUpError }}</p>
      </template>
      <p v-else-if="enabled && client.superAgent && followUpChecked && !hostSupportsFollowUp" role="status" class="mx-4 mb-3 text-xs text-ui-text-muted">{{ t("superAgent.followUp.hostUpdateRequired", { machine: machineName }) }}</p>
      <template v-if="enabled && client.superAgent?.history">
        <SettingsRow :label="t('superAgent.mode.history')" description-id="workspace-history-description">
          <template #description>{{ t("superAgent.mode.historyHint") }}</template>
          <UiButton size="sm" :disabled="busy" @click="organize()">{{ t("superAgent.mode.findUnassigned") }}</UiButton>
        </SettingsRow>
        <p v-if="groups?.length === 0" role="status" class="mx-4 mb-3 text-sm text-ui-text-muted">{{ t("superAgent.mode.empty") }}</p>
        <SettingsRow v-for="group in groups" :key="key(group)" :label="group.paths.join(' · ')">
          <template #description>{{ t("superAgent.mode.count", { count: group.sessionIds.length }) }}</template>
          <UiSelect v-if="group.projects.length" :model-value="choice(group)" :options="group.projects.map(p => ({ value: p.id, label: group.projects.filter(other => other.name === p.name).length > 1 ? p.name + ' (' + p.id + ')' : p.name }))" :placeholder="t('superAgent.mode.choose')" :aria-label="t('superAgent.mode.choose')" :disabled="busy" @update:model-value="selected[key(group)] = $event" />
          <UiButton size="sm" :disabled="busy || (!!group.projects.length && !choice(group))" @click="organize(group)">{{ t(group.projects.length ? "superAgent.mode.assign" : "superAgent.mode.create") }}</UiButton>
        </SettingsRow>
        <p v-if="error" role="alert" class="mx-4 mb-3 text-sm text-ui-danger">{{ error }}</p>
      </template>
    </div>
  </section>
</template>
