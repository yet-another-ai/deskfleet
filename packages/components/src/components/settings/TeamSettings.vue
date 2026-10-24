<script setup lang="ts">
import { Check, Ellipsis, Plus, Trash2, Users } from "@lucide/vue"
import { onClickOutside } from "@vueuse/core"
import { computed, nextTick, onMounted, ref, useId, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { CentralApi, Team, TeamMember } from "@deskfleet/client/central"
import IconButton from "../common/IconButton.vue"
import SettingsRow from "./SettingsRow.vue"

const props = defineProps<{ central: CentralApi; team: Team; userId: string }>()
const emit = defineEmits<{ changed: [] }>()
const { t, locale } = useI18n()
const id = useId()
const members = ref<TeamMember[]>([])
const name = ref(props.team.name)
const email = ref("")
const role = ref<"admin" | "member">("member")
const invite = ref<{ token: string; expiresAt: string }>()
const removing = ref<TeamMember>()
const loading = ref(true)
const busy = ref(false)
const error = ref<string>()
const dialogError = ref<string>()
const openMenu = ref<string>()
const list = useTemplateRef<HTMLElement>("list")
const inviteDialog = useTemplateRef<HTMLDialogElement>("inviteDialog")
const removeDialog = useTemplateRef<HTMLDialogElement>("removeDialog")
const inviteEmail = useTemplateRef<HTMLInputElement>("inviteEmail")
const inviteCode = useTemplateRef<HTMLTextAreaElement>("inviteCode")
const membersHeading = useTemplateRef<HTMLElement>("membersHeading")
const admin = computed(() => props.team.role === "admin")
const inviteExpiry = computed(() => invite.value ? new Intl.DateTimeFormat(locale.value.startsWith("zh") ? "zh-CN" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(invite.value.expiresAt)) : "")
let menuTrigger: HTMLButtonElement | undefined
watch(() => props.team.name, value => { name.value = value })
onClickOutside(list, () => { openMenu.value = undefined })

async function load(): Promise<void> {
  loading.value = true; error.value = undefined
  try { members.value = await props.central.members(props.team.id) }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { loading.value = false }
}
async function rename(): Promise<void> {
  if (busy.value || !admin.value || !name.value.trim()) return
  busy.value = true; error.value = undefined
  try { await props.central.renameTeam(props.team.id, name.value.trim()); emit("changed") }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
async function closeMenu(restoreFocus = true): Promise<void> {
  openMenu.value = undefined
  if (restoreFocus) { await nextTick(); menuTrigger?.focus() }
}
async function toggleMenu(member: TeamMember): Promise<void> {
  if (busy.value || !admin.value) return
  if (openMenu.value === member.userId) { await closeMenu(); return }
  menuTrigger = [...list.value!.querySelectorAll<HTMLButtonElement>("[data-member-actions]")].find(button => button.dataset.memberActions === member.userId)
  openMenu.value = member.userId
  await nextTick()
  list.value?.querySelector<HTMLButtonElement>('[role="menu"] button')?.focus()
}
function menuKey(event: KeyboardEvent): void {
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void closeMenu(); return }
  // Continue native Tab traversal from the trigger when the popup disappears.
  if (event.key === "Tab") { openMenu.value = undefined; menuTrigger?.focus(); return }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
  event.preventDefault()
  const buttons = [...list.value!.querySelectorAll<HTMLButtonElement>('[role="menu"] button:not(:disabled)')]
  const current = buttons.indexOf(event.target as HTMLButtonElement)
  const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
  buttons[index]?.focus()
}
async function changeRole(member: TeamMember, next: "admin" | "member"): Promise<void> {
  await closeMenu()
  if (busy.value || member.role === next) return
  busy.value = true; error.value = undefined
  try { await props.central.setMemberRole(props.team.id, member.userId, next); await load(); emit("changed") }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
async function askRemove(member: TeamMember): Promise<void> {
  await closeMenu()
  removing.value = member; dialogError.value = undefined
  await nextTick()
  removeDialog.value?.showModal()
}
function closeRemove(): void {
  if (busy.value) return
  removeDialog.value?.close(); removing.value = undefined
}
async function remove(): Promise<void> {
  if (!removing.value || busy.value) return
  busy.value = true; dialogError.value = undefined
  try {
    await props.central.removeMember(props.team.id, removing.value.userId)
    removeDialog.value?.close(); removing.value = undefined
    await load(); emit("changed")
    await nextTick(); membersHeading.value?.focus()
  } catch (reason) { dialogError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
async function openInvite(): Promise<void> {
  email.value = ""; role.value = "member"; invite.value = undefined; dialogError.value = undefined
  await nextTick()
  inviteDialog.value?.showModal()
  await nextTick(); inviteEmail.value?.focus()
}
function closeInvite(): void { if (!busy.value) inviteDialog.value?.close() }
async function inviteMember(): Promise<void> {
  if (busy.value) return
  busy.value = true; dialogError.value = undefined
  try {
    invite.value = await props.central.invite(props.team.id, email.value.trim(), role.value)
    await nextTick(); inviteCode.value?.focus()
  }
  catch (reason) { dialogError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
onMounted(load)
</script>

<template>
  <div class="mb-6 flex items-start justify-between gap-4">
    <div class="min-w-0">
      <h1 class="m-0 text-lg font-semibold">{{ t('account.teamSettings') }}</h1>
      <p class="m-0 mt-1 truncate text-[13px] text-ui-text-muted">{{ team.name }}</p>
    </div>
    <button v-if="admin" type="button" class="catalog-button shrink-0" :disabled="busy" @click="openInvite"><Plus :size="16" :stroke-width="1.75" aria-hidden="true" />{{ t('account.inviteMember') }}</button>
  </div>
  <section :aria-labelledby="`${id}-general`" class="mb-8">
    <h2 :id="`${id}-general`" class="ui-section-title">{{ t('account.general') }}</h2>
    <form @submit.prevent="rename">
      <SettingsRow :label="t('account.teamName')" :label-id="`${id}-name`">
        <template v-if="admin"><input v-model="name" class="catalog-input max-w-52" :aria-labelledby="`${id}-name`" name="team-name" required :disabled="busy" /><button class="catalog-button shrink-0" :disabled="busy || !name.trim() || name.trim() === team.name">{{ t('catalog.save') }}</button></template>
        <span v-else class="text-sm text-ui-text-muted">{{ team.name }}</span>
      </SettingsRow>
    </form>
  </section>
  <section :aria-labelledby="`${id}-members`">
    <div class="mb-3 flex items-center justify-between gap-3"><h2 :id="`${id}-members`" ref="membersHeading" tabindex="-1" class="ui-section-title !mb-0">{{ t('account.members') }}<span v-if="!loading" class="ml-2 text-ui-text-faint">{{ members.length }}</span></h2><button v-if="error" type="button" class="ui-text-button cursor-pointer hover:bg-ui-hover" :disabled="loading || busy" @click="load">{{ t('settings.retryLoad') }}</button></div>
    <p v-if="error" role="alert" class="m-0 mb-4 text-sm text-ui-danger">{{ error }}</p>
    <p v-if="loading && !members.length" role="status" class="m-0 py-6 text-sm text-ui-text-muted">{{ t('settings.loading') }}</p>
    <div v-else-if="members.length" ref="list" :aria-busy="loading" class="rounded-xl border border-ui-border bg-ui-surface shadow-ui-card">
      <div v-for="(member, index) in members" :key="member.userId" class="flex items-center gap-3 px-4 py-3.5" :class="index > 0 && 'border-t border-ui-border'" :data-member-id="member.userId">
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ui-badge text-sm font-medium text-ui-text-muted" aria-hidden="true">{{ member.name.slice(0, 1).toUpperCase() }}</span>
        <div class="min-w-0 flex-1"><div class="truncate text-sm font-medium">{{ member.name }}<span v-if="member.userId === userId" class="ml-1.5 text-xs font-normal text-ui-text-muted">{{ t('account.you') }}</span></div><div v-if="member.email" class="mt-0.5 truncate text-[13px] text-ui-text-muted">{{ member.email }}</div></div>
        <span class="ui-badge shrink-0 text-ui-text-muted">{{ t(`account.${member.role}`) }}</span>
        <div v-if="admin" class="relative shrink-0">
          <IconButton :icon="Ellipsis" :label="t('account.memberActions', { name: member.name })" :data-member-actions="member.userId" :disabled="busy" aria-haspopup="menu" :aria-expanded="openMenu === member.userId" :aria-controls="openMenu === member.userId ? `${id}-member-menu` : undefined" @click="toggleMenu(member)" @keydown.down.prevent="toggleMenu(member)" />
          <div v-if="openMenu === member.userId" :id="`${id}-member-menu`" role="menu" :aria-label="t('account.memberActions', { name: member.name })" class="absolute right-0 top-full z-20 mt-1 w-48 rounded-lg border border-ui-border bg-ui-surface p-1 shadow-ui-card" @keydown="menuKey">
            <div class="px-2 py-1.5 text-xs text-ui-text-faint">{{ t('account.role') }}</div>
            <button v-for="value in (['member', 'admin'] as const)" :key="value" type="button" role="menuitemradio" tabindex="-1" :aria-checked="member.role === value" class="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-ui-hover focus:bg-ui-hover" @click="changeRole(member, value)"><span class="flex-1">{{ t(`account.${value}`) }}</span><Check v-if="member.role === value" :size="14" aria-hidden="true" /></button>
            <div role="separator" class="my-1 border-t border-ui-border" />
            <button type="button" role="menuitem" tabindex="-1" class="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] text-ui-danger hover:bg-ui-hover focus:bg-ui-hover" @click="askRemove(member)"><Trash2 :size="14" aria-hidden="true" />{{ t('account.removeMember') }}</button>
          </div>
        </div>
      </div>
    </div>
    <div v-else-if="!error" class="flex flex-col items-center gap-2 rounded-xl border border-dashed border-ui-border px-6 py-10 text-ui-text-muted"><Users :size="28" :stroke-width="1.5" aria-hidden="true" /><p class="m-0 text-sm">{{ t('account.noMembers') }}</p></div>
  </section>

  <dialog ref="inviteDialog" class="ui-dialog app-no-drag w-[28rem] max-h-[85vh] overflow-y-auto" :aria-labelledby="`${id}-invite-title`" @cancel.prevent="closeInvite">
    <h2 :id="`${id}-invite-title`" class="m-0 mb-2 text-base font-semibold">{{ t(invite ? 'account.inviteReady' : 'account.inviteMember') }}</h2>
    <p class="m-0 mb-5 text-[13px] text-ui-text-muted">{{ t('account.inviteDescription', { team: team.name }) }}</p>
    <p v-if="dialogError" role="alert" class="m-0 mb-4 text-sm text-ui-danger">{{ dialogError }}</p>
    <template v-if="invite">
      <p class="m-0 mb-3 text-sm">{{ t('account.inviteInstructions', { expires: inviteExpiry }) }}</p>
      <label class="flex flex-col gap-1.5 text-sm">{{ t('account.inviteCode') }}<textarea ref="inviteCode" readonly class="catalog-input h-24 font-mono text-xs" :value="invite.token" @focus="($event.target as HTMLTextAreaElement).select()" /></label>
      <div class="mt-5 flex justify-end"><button type="button" class="catalog-button" @click="closeInvite">{{ t('account.done') }}</button></div>
    </template>
    <form v-else class="flex flex-col gap-4" @submit.prevent="inviteMember">
      <label class="flex flex-col gap-1.5 text-sm">{{ t('account.email') }}<input ref="inviteEmail" v-model="email" class="catalog-input" name="invite-email" type="email" autocomplete="email" required :disabled="busy" /></label>
      <label class="flex flex-col gap-1.5 text-sm">{{ t('account.role') }}<select v-model="role" class="catalog-input" :disabled="busy"><option value="member">{{ t('account.member') }}</option><option value="admin">{{ t('account.admin') }}</option></select></label>
      <p class="m-0 text-xs text-ui-text-muted">{{ t(role === 'admin' ? 'account.adminDescription' : 'account.memberDescription') }}</p>
      <div class="mt-1 flex justify-end gap-2"><button type="button" class="catalog-button" :disabled="busy" @click="closeInvite">{{ t('catalog.cancel') }}</button><button class="catalog-button" :disabled="busy">{{ busy ? t('catalog.saving') : t('account.createInvite') }}</button></div>
    </form>
  </dialog>
  <dialog ref="removeDialog" class="ui-dialog app-no-drag w-[26rem]" :aria-labelledby="`${id}-remove-title`" @cancel.prevent="closeRemove">
    <h2 :id="`${id}-remove-title`" class="m-0 mb-2 text-base font-semibold">{{ t('account.removeMember') }}</h2>
    <p class="m-0 mb-4 text-sm text-ui-text-muted">{{ t('account.removeQuestion', { name: removing?.name ?? '' }) }}</p>
    <p v-if="dialogError" role="alert" class="m-0 mb-4 text-sm text-ui-danger">{{ dialogError }}</p>
    <div class="flex justify-end gap-2"><button type="button" class="catalog-button" :disabled="busy" @click="closeRemove">{{ t('catalog.cancel') }}</button><button type="button" class="catalog-button text-ui-danger" :disabled="busy" @click="remove">{{ t('account.remove') }}</button></div>
  </dialog>
</template>
