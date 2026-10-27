<script setup lang="ts">
import { Link2Off, MonitorSmartphone } from "@lucide/vue"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import type { AccountAuthentication } from "@deskfleet/client/account-security"
import type { AccountUser } from "@deskfleet/client/central"
import { failureMessage, useRecentAuthentication } from "../../composables/useRecentAuthentication.ts"
import UiButton from "../common/UiButton.vue"
import UserAvatar from "../common/UserAvatar.vue"
import AuthLayout from "./AuthLayout.vue"
import ReauthDialog from "./ReauthDialog.vue"

/** The system browser approves the desktop app's one-use login attempt for the signed-in account. */
const props = defineProps<{ account: AccountAuthentication; user: AccountUser; attempt?: string; signOut(): Promise<void> }>()
const { t } = useI18n()
const recent = useRecentAuthentication()
const pending = ref(false)
const error = ref<string>()

async function run(action: () => Promise<void>): Promise<void> {
  if (pending.value) return
  pending.value = true
  error.value = undefined
  try { await action() } catch (reason) { error.value = failureMessage(reason) }
  finally { pending.value = false }
}
function approve(): void {
  void run(async () => {
    const { returnTo } = await recent.confirmed(() => props.account.completeDesktop(props.attempt!))
    location.assign(returnTo)
  })
}
</script>

<template>
  <AuthLayout v-if="!attempt" :icon="Link2Off" :title="t('auth.linkInvalid')" :description="t('auth.desktopAttemptMissing')" />
  <AuthLayout v-else :icon="MonitorSmartphone" :title="t('auth.desktopTitle')" :description="t('auth.desktopDescription')">
    <form class="flex flex-col gap-4" @submit.prevent="approve">
      <div class="flex items-center gap-3 rounded-lg border border-ui-border bg-ui-sidebar px-3 py-2.5">
        <UserAvatar :name="user.name" :email="user.email" :size="32" class="text-[13px]" />
        <div class="min-w-0">
          <div class="truncate text-sm font-medium">{{ user.name }}</div>
          <div class="truncate text-[13px] text-ui-text-muted">{{ user.email }}</div>
        </div>
      </div>
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <UiButton type="submit" variant="primary" class="h-9 text-sm" :loading="pending">{{ t("auth.continueDesktop") }}</UiButton>
      <UiButton variant="ghost" class="h-9 text-sm" :disabled="pending" @click="run(signOut)">{{ t("auth.differentAccount") }}</UiButton>
    </form>
  </AuthLayout>
  <ReauthDialog v-if="recent.prompting.value" :reauthenticate="account.reauthenticate" @settle="recent.settle" />
</template>
