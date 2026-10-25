<script setup lang="ts">
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import BrandLogo from "../common/BrandLogo.vue"

defineProps<{ platform: string }>()
const { t } = useI18n()
const session = useAccountSession()!
const serverUrl = ref(session.account.value.serverUrl)
const pending = ref(false)
// A failed login redirect returns here with its reason.
const error = ref(session.notice.value)

async function submit(): Promise<void> {
  if (pending.value) return
  pending.value = true
  error.value = undefined
  session.notice.value = undefined
  try { await session.signIn(serverUrl.value.trim()) }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { pending.value = false }
}
</script>

<template>
  <div class="app-drag titlebar-overlay-inset flex h-12 shrink-0 items-center gap-2 px-5 text-[13px] font-medium" :class="platform === 'darwin' && 'pl-20'"><BrandLogo :size="24" decorative />deskfleet</div>
  <div class="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6 pb-18">
    <form class="ui-card flex w-full max-w-sm flex-col gap-5 p-6 shadow-ui-card" @submit.prevent="submit">
      <div>
        <BrandLogo :size="64" class="mb-5" />
        <h1 class="m-0 text-xl font-semibold">{{ t("account.signIn") }}</h1>
        <p class="m-0 mt-2 text-sm text-ui-text-muted">{{ t("account.signInDescription") }}</p>
      </div>
      <label class="flex flex-col gap-1.5 text-sm">
        {{ t("account.server") }}
        <input v-model="serverUrl" type="url" name="server-url" class="ui-input" required autocomplete="url" :disabled="pending" placeholder="https://deskfleet.example.com" />
      </label>
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <button class="ui-button-primary h-9 text-sm" type="submit" :disabled="pending">{{ pending ? t("account.signingIn") : t("account.continueOidc") }}</button>
    </form>
  </div>
</template>
