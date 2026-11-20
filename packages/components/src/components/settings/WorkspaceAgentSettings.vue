<script setup lang="ts">
import { onScopeDispose, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { SuperHistoryGroup } from "../../../../../apps/daemon/src/super-agent-protocol.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { projectDirectoryName, useWorkspaceAgentMode } from "../../services/workspace-agent-navigation.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import UiButton from "../common/UiButton.vue"
import UiSelect from "../common/UiSelect.vue"
import UiSwitch from "../common/UiSwitch.vue"
import SettingsRow from "./SettingsRow.vue"

const { t } = useI18n()
const enabled = useWorkspaceAgentMode()
const client = usePlatformClient()
const fleet = useFleetStore()
const groups = ref<SuperHistoryGroup[]>()
const selected = ref<Record<string, string>>({})
const busy = ref(false)
const error = ref("")
let revision = 0
watch(enabled, () => { ++revision; groups.value = undefined; selected.value = {}; error.value = ""; busy.value = false }, { flush: "sync" })
onScopeDispose(() => { ++revision })
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
      <template v-if="enabled && client.superAgent?.history">
        <SettingsRow :label="t('superAgent.mode.history', { machine: fleet.localDesktopTarget.name })" description-id="workspace-history-description">
          <template #description>{{ t("superAgent.mode.historyHint") }}</template>
          <UiButton size="sm" :disabled="busy" @click="organize()">{{ t(groups === undefined ? "superAgent.mode.organize" : "superAgent.setup.checkAgain") }}</UiButton>
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
