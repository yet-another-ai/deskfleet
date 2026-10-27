<script setup lang="ts">
import { LogOut, Monitor } from "@lucide/vue"
import { useAsyncState } from "@vueuse/core"
import { ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import type { AccountAuthentication, LoginSession } from "@deskfleet/client/account-security"
import { failureMessage, type RecentAuthentication } from "../../composables/useRecentAuthentication.ts"
import ConfirmDialog from "../common/ConfirmDialog.vue"
import IconButton from "../common/IconButton.vue"
import UiButton from "../common/UiButton.vue"

/** Login sessions are browser and desktop sign-ins, not enrolled Machines. */
const props = defineProps<{ account: AccountAuthentication; confirmed: RecentAuthentication["confirmed"]; formatDate(value: string | number): string }>()
const { t } = useI18n()
const id = useId()
const { state: sessions, isLoading, error: loadError, executeImmediate: load } = useAsyncState(() => props.account.sessions(), [])
const revoking = ref<LoginSession | "all">()

async function revoke(target: LoginSession | "all"): Promise<void> {
  if (target === "all") await props.confirmed(() => props.account.revokeAllSessions())
  else await props.account.revokeSession(target.id)
  if (target === "all" || target.current) location.assign("/auth/login")
  else sessions.value = sessions.value.filter(value => value.id !== target.id)
}
</script>

<template>
  <section :aria-labelledby="`${id}-title`" class="mb-8">
    <div class="ui-section-header">
      <h2 :id="`${id}-title`" class="ui-section-title">{{ t("auth.sessions") }}<span v-if="!isLoading && !loadError" class="ml-1.5 text-ui-text-faint">{{ sessions.length }}</span></h2>
      <UiButton v-if="sessions.length > 1" variant="danger" @click="revoking = 'all'">{{ t("auth.revokeAll") }}</UiButton>
    </div>
    <p class="m-0 mb-2 text-[13px] text-ui-text-muted">{{ t("auth.sessionsDescription") }}</p>
    <p v-if="isLoading" role="status" class="m-0 py-4 text-sm text-ui-text-muted">{{ t("auth.loading") }}</p>
    <div v-else-if="loadError" class="flex items-center justify-between gap-4">
      <p role="alert" class="m-0 text-sm text-ui-danger">{{ failureMessage(loadError) }}</p>
      <UiButton @click="load()">{{ t("auth.retry") }}</UiButton>
    </div>
    <ul v-else class="ui-card m-0 list-none p-0 shadow-ui-card">
      <li v-for="session in sessions" :key="session.id" class="ui-card-row py-3" :data-login-session="session.id">
        <Monitor :size="16" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 text-sm">
            {{ t(session.current ? "auth.thisSession" : "auth.otherSession") }}
            <span v-if="session.current" class="ui-badge">{{ t("auth.current") }}</span>
          </div>
          <div class="text-[13px] text-ui-text-muted">{{ t("auth.sessionDates", { created: formatDate(session.createdAt), expires: formatDate(session.expiresAt) }) }}</div>
        </div>
        <IconButton :icon="LogOut" :label="t('auth.revoke')" @click="revoking = session" />
      </li>
    </ul>
  </section>
  <ConfirmDialog
    v-if="revoking"
    :title="t(revoking === 'all' ? 'auth.revokeAllTitle' : revoking.current ? 'auth.revokeCurrentTitle' : 'auth.revokeTitle')"
    :description="t(revoking === 'all' ? 'auth.revokeAllDescription' : 'auth.revokeDescription')"
    :confirm-label="t(revoking === 'all' ? 'auth.revokeAll' : 'auth.revoke')"
    :confirm="() => revoke(revoking!)"
    @close="revoking = undefined"
  />
</template>
