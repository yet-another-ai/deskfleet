<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import { DialogTitle, RadioGroupRoot, RadioGroupItem, RadioGroupIndicator } from "reka-ui"
import { computed, nextTick, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { Team } from "@deskfleet/client/central"
import { intlLocale, type AppLocale } from "../../../../client/src/i18n.ts"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { captureAnalyticsContext } from "../../services/analytics.ts"
import CopyField from "../common/CopyField.vue"
import UiDialog from "../common/UiDialog.vue"

const props = defineProps<{ team: Team }>()
const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const central = useAccountSession()!.central
const code = useTemplateRef<InstanceType<typeof CopyField>>("code")
const email = ref("")
const role = ref<"admin" | "member">("member")
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
  const invitedRole = role.value
  const track = captureAnalyticsContext()
  track("member_invite_action", { outcome: "attempt", invited_role: invitedRole })
  try {
    invite.value = await central.invite(props.team.id, email.value.trim(), invitedRole)
    track("member_invite_action", { outcome: "success", invited_role: invitedRole })
    await nextTick()
    code.value?.focus()
  } catch (reason) {
    track("member_invite_action", { outcome: "failure", invited_role: invitedRole })
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
  finally { pending.value = false }
}
</script>

<template>
  <UiDialog class="w-[28rem]" :prevent-close="pending" @close="close">
    <DialogTitle class="ui-dialog-title">{{ t(invite ? "team.inviteReady" : "team.inviteTitle", { team: team.name }) }}</DialogTitle>
    <template v-if="invite">
      <p class="ui-dialog-description mb-5">{{ t("team.inviteInstructions", { email: email.trim(), expires }) }}</p>
      <CopyField ref="code" :label="t('team.inviteCode')" :value="invite.token" />
      <div class="ui-dialog-actions"><UiButton variant="primary" type="button" @click="close">{{ t("account.done") }}</UiButton></div>
    </template>
    <form v-else class="flex flex-col gap-4" @submit.prevent="submit">
      <p class="ui-dialog-description">{{ t("team.inviteDescription") }}</p>
      <label class="flex flex-col gap-1.5 text-sm">
        {{ t("team.email") }}
        <input v-model="email" class="ui-input" name="invite-email" type="email" autocomplete="off" required :disabled="pending" />
      </label>
      <div class="flex flex-col gap-2">
        <span class="mb-1.5 text-sm">{{ t("team.role") }}</span>
        <RadioGroupRoot v-model="role" name="invite-role" :aria-label="t('team.role')" :disabled="pending" class="flex flex-col gap-2">
        <RadioGroupItem v-for="value in (['member', 'admin'] as const)" :key="value" :value="value" class="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left disabled:cursor-default disabled:op-50" :class="role === value ? 'border-ui-accent bg-ui-accent/6' : 'border-ui-border hover:border-ui-border-strong'">
          <span class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-ui-border-strong"><RadioGroupIndicator class="h-2 w-2 rounded-full bg-ui-accent" /></span>
          <span class="flex flex-col gap-0.5">
            <span class="text-sm">{{ t(value === "admin" ? "team.admin" : "team.member") }}</span>
            <span class="text-xs text-ui-text-muted">{{ t(value === "admin" ? "team.adminDescription" : "team.memberDescription") }}</span>
          </span>
        </RadioGroupItem>
        </RadioGroupRoot>
      </div>
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <div class="mt-2 flex justify-end gap-2">
        <UiButton type="button" :disabled="pending" @click="close">{{ t("catalog.cancel") }}</UiButton>
        <UiButton variant="primary" type="submit" :loading="pending" :disabled="pending || !email.trim()">{{ pending ? t("team.creatingInvite") : t("team.createInvite") }}</UiButton>
      </div>
    </form>
  </UiDialog>
</template>
