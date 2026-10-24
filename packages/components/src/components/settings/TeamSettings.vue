<script setup lang="ts">
import { onMounted, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { CentralApi, Team, TeamMember } from "@deskfleet/client/central"

const props = defineProps<{ central: CentralApi; team: Team; userId: string }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const { t } = useI18n()
const dialog = useTemplateRef<HTMLDialogElement>("dialog")
const members = ref<TeamMember[]>([])
const name = ref(props.team.name)
const email = ref("")
const role = ref<"admin" | "member">("member")
const invite = ref<{ token: string; expiresAt: string }>()
const removing = ref<TeamMember>()
const busy = ref(false)
const error = ref<string>()
async function action(work: () => Promise<void>) {
  busy.value = true; error.value = undefined
  try { await work() } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
async function load() { members.value = await props.central.members(props.team.id) }
async function rename() { await action(async () => { await props.central.renameTeam(props.team.id, name.value); emit("changed") }) }
async function changeRole(member: TeamMember, event: Event) {
  const next = (event.target as HTMLSelectElement).value as "admin" | "member"
  await action(async () => { await props.central.setMemberRole(props.team.id, member.userId, next); await load(); emit("changed") })
}
async function remove() {
  const member = removing.value
  if (!member) return
  await action(async () => { await props.central.removeMember(props.team.id, member.userId); removing.value = undefined; await load(); emit("changed") })
}
async function inviteMember() { await action(async () => { invite.value = await props.central.invite(props.team.id, email.value.trim(), role.value) }) }
onMounted(() => { dialog.value?.showModal(); void action(load) })
</script>

<template>
  <dialog ref="dialog" class="ui-dialog app-no-drag w-[40rem] max-w-[95vw] max-h-[85vh]" :aria-label="t('account.teamSettings')" @close="emit('close')">
    <div class="mb-5 flex items-center justify-between gap-4"><h2 class="m-0 text-lg font-semibold">{{ t('account.teamSettings') }}</h2><button class="catalog-button" @click="dialog?.close()">{{ t('account.close') }}</button></div>
    <p v-if="error" role="alert" class="text-sm text-ui-danger">{{ error }}</p>
    <form v-if="team.role === 'admin'" class="mb-5 flex gap-2" @submit.prevent="rename"><input v-model="name" class="catalog-input" :aria-label="t('account.teamName')" required /><button class="catalog-button" :disabled="busy">{{ t('catalog.save') }}</button></form>
    <h3 class="text-sm font-semibold">{{ t('account.members') }}</h3>
    <ul class="ui-card m-0 mb-5 list-none p-0">
      <li v-for="member in members" :key="member.userId" class="ui-card-row border-b border-ui-border last:border-b-0">
        <div class="min-w-0 flex-1"><div class="truncate text-sm">{{ member.name }}</div><div class="truncate text-xs text-ui-text-muted">{{ member.email }}</div></div>
        <select v-if="team.role === 'admin'" :value="member.role" class="catalog-input !w-auto" :aria-label="t('account.memberRole', { name: member.name })" :disabled="busy" @change="changeRole(member, $event)"><option value="member">{{ t('account.member') }}</option><option value="admin">{{ t('account.admin') }}</option></select>
        <span v-else class="ui-badge">{{ t(`account.${member.role}`) }}</span>
        <button v-if="team.role === 'admin'" class="catalog-button text-ui-danger" :disabled="busy" @click="removing = member">{{ t('account.remove') }}</button>
      </li>
    </ul>
    <div v-if="removing" class="ui-card mb-5 p-4"><p class="m-0 mb-3 text-sm">{{ t('account.removeQuestion', { name: removing.name }) }}</p><div class="flex justify-end gap-2"><button class="catalog-button" :disabled="busy" @click="removing = undefined">{{ t('catalog.cancel') }}</button><button class="catalog-button text-ui-danger" :disabled="busy" @click="remove">{{ t('account.remove') }}</button></div></div>
    <form v-if="team.role === 'admin'" class="flex flex-col gap-3" @submit.prevent="inviteMember">
      <h3 class="m-0 text-sm font-semibold">{{ t('account.inviteMember') }}</h3>
      <div class="flex gap-2"><input v-model="email" class="catalog-input" type="email" :aria-label="t('account.email')" :placeholder="t('account.email')" required /><select v-model="role" class="catalog-input !w-auto" :aria-label="t('account.role')"><option value="member">{{ t('account.member') }}</option><option value="admin">{{ t('account.admin') }}</option></select><button class="catalog-button shrink-0" :disabled="busy">{{ t('account.createInvite') }}</button></div>
      <template v-if="invite"><p class="m-0 text-xs text-ui-text-muted">{{ t('account.inviteInstructions', { expires: invite.expiresAt }) }}</p><textarea readonly class="catalog-input font-mono text-xs" :aria-label="t('account.inviteCode')" :value="invite.token" @focus="($event.target as HTMLTextAreaElement).select()" /></template>
    </form>
  </dialog>
</template>
