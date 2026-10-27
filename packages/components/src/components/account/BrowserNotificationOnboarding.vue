<script setup lang="ts">
import { Bell } from "@lucide/vue"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { requestBrowserNotificationPermission } from "@deskfleet/client/browser-notifications"
import BrandLogo from "../common/BrandLogo.vue"
import UiButton from "../common/UiButton.vue"

defineProps<{ siteName: string }>()
const emit = defineEmits<{ complete: [] }>()
const { t } = useI18n()
const pending = ref(false)
const error = ref<string>()

async function enable(): Promise<void> {
  if (pending.value) return
  pending.value = true
  error.value = undefined
  try {
    // Keep the browser request in the click's user activation, before any other await.
    await requestBrowserNotificationPermission()
    emit("complete")
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { pending.value = false }
}
</script>

<template>
  <div class="flex h-12 shrink-0 items-center gap-2 px-5 text-[13px] font-medium">
    <BrandLogo :size="24" decorative />{{ siteName }}
  </div>
  <main class="flex min-h-0 flex-1 justify-center overflow-y-auto p-5 sm:p-8">
    <div class="ui-card my-auto grid w-full max-w-4xl overflow-hidden shadow-ui-card md:grid-cols-[0.9fr_1.1fr]">
      <aside class="flex flex-col gap-6 border-b border-ui-border bg-ui-sidebar p-7 md:border-b-0 md:border-r md:p-9">
        <div>
          <BrandLogo :size="52" class="mb-5" />
          <p class="m-0 text-2xl font-semibold tracking-tight">{{ t("welcome.title") }}</p>
          <p class="m-0 mt-3 max-w-xs text-sm leading-relaxed text-ui-text-muted">{{ t("welcome.notificationsDescription") }}</p>
        </div>
      </aside>
      <section class="flex min-w-0 flex-col justify-center p-7 md:min-h-110 md:p-9">
        <Bell :size="30" :stroke-width="1.5" class="mb-5 text-ui-text-muted" aria-hidden="true" />
        <h1 class="m-0 text-xl font-semibold">{{ t("welcome.notificationsTitle") }}</h1>
        <p class="m-0 mt-3 text-sm leading-relaxed text-ui-text-muted">{{ t("welcome.notificationsDetails") }}</p>
        <p v-if="error" role="alert" class="m-0 mt-4 break-words text-sm text-ui-danger">{{ error }}</p>
        <div class="mt-6 flex flex-wrap gap-2">
          <UiButton variant="primary" :disabled="pending" @click="enable">{{ t("settings.enableBrowserNotifications") }}</UiButton>
          <UiButton :disabled="pending" @click="emit('complete')">{{ t("welcome.skip") }}</UiButton>
        </div>
      </section>
    </div>
  </main>
</template>
