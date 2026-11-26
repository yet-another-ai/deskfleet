<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import { computed, ref, useId, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import ConfirmDialog from "../common/ConfirmDialog.vue"
import SettingsRow from "../settings/SettingsRow.vue"
import TeamMachines from "./TeamMachines.vue"
import TeamMembers from "./TeamMembers.vue"
import TeamSuperAgentSettings from "./TeamSuperAgentSettings.vue"
import TeamTurnSettings from "./TeamTurnSettings.vue"

const { t } = useI18n()
const id = useId()
const session = useAccountSession()
const team = computed(() => session?.team.value)
const admin = computed(() => team.value?.role === "owner" || team.value?.role === "admin")
const name = ref(team.value?.name ?? "")
const saving = ref(false)
const confirmingDelete = ref(false)
const error = ref<string>()
const changed = computed(() => !!name.value.trim() && name.value.trim() !== team.value?.name)
watch(() => team.value?.name, value => { name.value = value ?? ""; error.value = undefined })

async function rename(): Promise<void> {
  if (!session || saving.value || !changed.value) return
  saving.value = true
  error.value = undefined
  try { await session.renameTeam(name.value.trim()) }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { saving.value = false }
}
async function deleteTeam(): Promise<void> {
  if (!session) return
  await session.deleteTeam()
}
</script>

<template>
  <template v-if="session && team">
    <header class="mb-8">
      <h1 class="ui-page-title truncate">{{ team.name }}</h1>
      <p class="m-0 mt-1 text-[13px] text-ui-text-muted">{{ t(team.role === "owner" ? "team.youAreOwner" : admin ? "team.youAreAdmin" : "team.youAreMember") }}</p>
    </header>
    <section v-if="admin" :aria-labelledby="`${id}-general`" class="mb-8">
      <h2 :id="`${id}-general`" class="ui-section-title mb-2">{{ t("team.general") }}</h2>
      <form class="ui-card" @submit.prevent="rename">
        <SettingsRow :label="t('team.name')" :label-id="`${id}-name`">
          <input v-model="name" class="ui-input w-56" :aria-labelledby="`${id}-name`" name="team-name" required maxlength="256" autocomplete="off" :disabled="saving" />
          <UiButton type="submit" class="shrink-0" :disabled="saving || !changed">{{ saving ? t("catalog.saving") : t("catalog.save") }}</UiButton>
        </SettingsRow>
      </form>
      <p v-if="error" role="alert" class="m-0 mt-2 text-sm text-ui-danger">{{ error }}</p>
    </section>
    <TeamMembers :key="team.id" :team="team" :user-id="session.account.value.user?.id" />
    <TeamMachines />
    <TeamSuperAgentSettings v-if="session.superAgentEnabled.value" :key="`super-agent-${team.id}`" class="mt-8" :api="session.central" :team-id="team.id" :machines="session.machines.value" :local-machine-id="session.localMachineId.value" />
    <TeamTurnSettings v-if="admin" :key="team.id" class="mt-8" :api="session.central" :team-id="team.id" @plans="session.openSettings('plans')" />
    <section v-if="team.role === 'owner'" :aria-labelledby="`${id}-danger`" class="mt-8">
      <h2 :id="`${id}-danger`" class="ui-section-title mb-2">{{ t("team.dangerZone") }}</h2>
      <div class="ui-card">
        <SettingsRow :label="t('team.deleteTeam')" :label-id="`${id}-delete`">
          <template #description>{{ t("team.deleteTeamDescription") }}</template>
          <UiButton variant="danger" type="button" :aria-labelledby="`${id}-delete`" @click="confirmingDelete = true">{{ t("team.deleteTeam") }}</UiButton>
        </SettingsRow>
      </div>
    </section>
  </template>
  <ConfirmDialog
    v-if="confirmingDelete && session && team"
    :title="t('team.deleteTeamTitle', { team: team.name })"
    :description="t('team.deleteTeamConfirmDescription')"
    :confirm-label="t('team.deleteTeam')"
    :confirm="deleteTeam"
    @close="confirmingDelete = false"
  />
</template>
