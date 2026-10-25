<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { Team, TeamMember } from "@deskfleet/client/central"
import { intlLocale, type AppLocale } from "../../../../client/src/i18n.ts"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import CopyField from "../common/CopyField.vue"

const props = defineProps<{ team: Team }>()
const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const id = useId()
const central = useAccountSession()!.central
const dialog = useTemplateRef<HTMLDialogElement>("dialog")
const emailInput = useTemplateRef<HTMLInputElement>("emailInput")
const code = useTemplateRef<InstanceType<typeof CopyField>>("code")
const email = ref("")
const role = ref<TeamMember["role"]>("member")
const pending = ref(false)
const error = ref<string>()
const invite = ref<{ token: string; expiresAt: string }>()
const expires = computed(() => invite.value
  ? new Intl.DateTimeFormat(intlLocale(locale.value as AppLocale), { dateStyle: "medium", timeStyle: "short" }).format(new Date(invite.value.expiresAt))
  : "")

function close(): void { if (!pending.value) emit("close") }
async function submit(): Promise<void> {
  if (pending.value) return
  pending.value = true
  error.value = undefined
  try {
    invite.value = await central.invite(props.team.id, email.value.trim(), role.value)
    await nextTick()
    code.value?.focus()
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { pending.value = false }
}
onMounted(() => { dialog.value?.showModal(); emailInput.value?.focus() })
</script>

<template>
  <dialog ref="dialog" class="ui-dialog app-no-drag w-[28rem]" :aria-labelledby="`${id}-title`" @cancel.prevent="close">
    <h2 :id="`${id}-title`" class="m-0 mb-1 text-base font-semibold">{{ t(invite ? "team.inviteReady" : "team.inviteTitle", { team: team.name }) }}</h2>
    <template v-if="invite">
      <p class="m-0 mb-5 text-[13px] text-ui-text-muted">{{ t("team.inviteInstructions", { email: email.trim(), expires }) }}</p>
      <CopyField ref="code" :label="t('team.inviteCode')" :value="invite.token" />
      <div class="mt-5 flex justify-end"><button type="button" class="catalog-button" @click="close">{{ t("account.done") }}</button></div>
    </template>
    <form v-else class="flex flex-col gap-4" @submit.prevent="submit">
      <p class="m-0 text-[13px] text-ui-text-muted">{{ t("team.inviteDescription") }}</p>
      <label class="flex flex-col gap-1.5 text-sm">
        {{ t("team.email") }}
        <input ref="emailInput" v-model="email" class="catalog-input" name="invite-email" type="email" autocomplete="off" required :disabled="pending" />
      </label>
      <fieldset class="m-0 flex flex-col gap-2 border-0 p-0" :disabled="pending">
        <legend class="mb-1.5 p-0 text-sm">{{ t("team.role") }}</legend>
        <label v-for="value in (['member', 'admin'] as const)" :key="value" class="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5" :class="role === value ? 'border-ui-text-muted bg-ui-surface' : 'border-ui-border'">
          <input v-model="role" type="radio" name="invite-role" :value="value" class="mt-0.5" />
          <span class="flex flex-col gap-0.5">
            <span class="text-sm">{{ t(value === "admin" ? "team.admin" : "team.member") }}</span>
            <span class="text-xs text-ui-text-muted">{{ t(value === "admin" ? "team.adminDescription" : "team.memberDescription") }}</span>
          </span>
        </label>
      </fieldset>
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <div class="mt-1 flex justify-end gap-2">
        <button type="button" class="catalog-button" :disabled="pending" @click="close">{{ t("catalog.cancel") }}</button>
        <button type="submit" class="catalog-button" :disabled="pending || !email.trim()">{{ pending ? t("team.creatingInvite") : t("team.createInvite") }}</button>
      </div>
    </form>
  </dialog>
</template>
