<script setup lang="ts">
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"

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
  <div class="app-drag titlebar-overlay-inset flex h-12 shrink-0 items-center px-5 text-[13px] font-medium" :class="platform === 'darwin' && 'pl-20'">deskfleet</div>
  <div class="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6 pb-18">
    <form class="flex w-full max-w-sm flex-col gap-5" @submit.prevent="submit">
      <div>
        <h1 class="m-0 text-xl font-semibold">{{ t("account.signIn") }}</h1>
        <p class="m-0 mt-2 text-sm text-ui-text-muted">{{ t("account.signInDescription") }}</p>
      </div>
      <label class="flex flex-col gap-1.5 text-sm">
        {{ t("account.server") }}
        <input v-model="serverUrl" type="url" name="server-url" class="catalog-input" required autocomplete="url" :disabled="pending" placeholder="https://deskfleet.example.com" />
      </label>
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <button class="inline-flex h-9 cursor-pointer items-center justify-center rounded-lg bg-ui-action px-3 text-sm text-ui-action-text disabled:cursor-default disabled:bg-ui-action-disabled" type="submit" :disabled="pending">{{ pending ? t("account.signingIn") : t("account.continueOidc") }}</button>
    </form>
  </div>
</template>
