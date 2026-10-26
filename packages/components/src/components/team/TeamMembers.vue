<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import UiSelect from "../common/UiSelect.vue"
import { Trash2, UserPlus } from "@lucide/vue"
import { computed, onMounted, ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import type { Team, TeamMember } from "@deskfleet/client/central"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import ConfirmDialog from "../common/ConfirmDialog.vue"
import IconButton from "../common/IconButton.vue"
import UserAvatar from "../common/UserAvatar.vue"
import InviteDialog from "./InviteDialog.vue"

const props = defineProps<{ team: Team; userId?: string }>()
const { t } = useI18n()
const id = useId()
const central = useAccountSession()!.central
const members = ref<TeamMember[]>([])
const loading = ref(true)
const error = ref<string>()
const updating = ref<string>()
const removing = ref<TeamMember>()
const inviting = ref(false)
const admin = computed(() => props.team.role === "admin")
// Administrators cannot change or remove themselves here; another administrator can.
const manageable = (member: TeamMember) => admin.value && member.userId !== props.userId

async function load(): Promise<void> {
  loading.value = true
  error.value = undefined
  try { members.value = await central.members(props.team.id) }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { loading.value = false }
}
async function changeRole(member: TeamMember, value: string): Promise<void> {
  const role = value as TeamMember["role"]
  if (updating.value || member.role === role) return
  updating.value = member.userId
  error.value = undefined
  try {
    await central.setMemberRole(props.team.id, member.userId, role)
    member.role = role
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally { updating.value = undefined }
}
async function remove(member: TeamMember): Promise<void> {
  await central.removeMember(props.team.id, member.userId)
  members.value = members.value.filter(value => value.userId !== member.userId)
}
onMounted(load)
</script>

<template>
  <section :aria-labelledby="`${id}-title`" class="mb-8">
    <div class="ui-section-header">
      <h2 :id="`${id}-title`" class="ui-section-title">
        {{ t("team.members") }}<span v-if="!loading && !error" class="ml-1.5 text-ui-text-faint">{{ members.length }}</span>
      </h2>
      <UiButton v-if="admin" type="button" class="shrink-0" @click="inviting = true">
        <UserPlus :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("team.invite") }}
      </UiButton>
    </div>
    <div v-if="error" class="mb-3 flex items-center justify-between gap-4">
      <p role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <UiButton v-if="!members.length" type="button" class="shrink-0" :disabled="loading" @click="load">{{ t("settings.retryLoad") }}</UiButton>
    </div>
    <p v-if="loading" role="status" class="m-0 py-4 text-sm text-ui-text-muted">{{ t("settings.loading") }}</p>
    <ul v-else-if="members.length" class="ui-card m-0 list-none p-0 shadow-ui-card">
      <li v-for="(member, index) in members" :key="member.userId" class="flex items-center gap-3 px-4 py-3" :class="index > 0 && 'border-t border-ui-border'" :data-member-id="member.userId">
        <UserAvatar :name="member.name" :email="member.email" :size="32" class="text-[13px]" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm">
            {{ member.name }}<span v-if="member.userId === userId" class="ml-1.5 text-[13px] text-ui-text-muted">{{ t("team.you") }}</span>
          </div>
          <div v-if="member.email" class="truncate text-[13px] text-ui-text-muted">{{ member.email }}</div>
        </div>
        <div v-if="manageable(member)" class="w-28 shrink-0">
          <UiSelect :aria-label="t('team.roleFor', { name: member.name })" :model-value="member.role" :options="[{ value: 'member', label: t('team.member') }, { value: 'admin', label: t('team.admin') }]" :disabled="!!updating" @update:model-value="changeRole(member, $event)" />
        </div>
        <span v-else class="ui-badge shrink-0">{{ t(member.role === "admin" ? "team.admin" : "team.member") }}</span>
        <IconButton v-if="manageable(member)" :icon="Trash2" :label="t('team.removeMemberLabel', { name: member.name })" :disabled="!!updating" @click="removing = member" />
        <span v-else-if="admin" class="w-7 shrink-0" aria-hidden="true" />
      </li>
    </ul>
  </section>
  <InviteDialog v-if="inviting" :team="team" @close="inviting = false" />
  <ConfirmDialog
    v-if="removing"
    :title="t('team.removeMemberTitle', { name: removing.name })"
    :description="t('team.removeMemberDescription', { team: team.name })"
    :confirm-label="t('team.remove')"
    :confirm="() => remove(removing!)"
    @close="removing = undefined"
  />
</template>
