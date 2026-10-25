<script setup lang="ts">
import { ChevronRight, Plus, Ticket } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"

const { t } = useI18n()
const session = useAccountSession()!
</script>

<template>
  <!-- A signed-in user with no Team chooses between starting one and accepting an invitation. -->
  <div class="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-6 pb-16">
    <div>
      <h1 class="m-0 text-xl font-semibold">{{ t("team.welcome", { name: session.account.value.user?.name ?? "" }) }}</h1>
      <p class="m-0 mt-2 text-sm text-ui-text-muted">{{ t("team.welcomeDescription") }}</p>
    </div>
    <div class="flex flex-col gap-2">
      <button type="button" class="ui-option-card" @click="session.dialog.value = 'create-team'">
        <Plus :size="20" :stroke-width="1.75" class="shrink-0 text-ui-accent" aria-hidden="true" />
        <span class="min-w-0 flex-1"><span class="block text-sm">{{ t("team.create") }}</span><span class="mt-0.5 block text-[13px] text-ui-text-muted">{{ t("team.createDescription") }}</span></span>
        <ChevronRight :size="16" class="shrink-0 text-ui-text-faint" aria-hidden="true" />
      </button>
      <button type="button" class="ui-option-card" @click="session.dialog.value = 'join-team'">
        <Ticket :size="20" :stroke-width="1.75" class="shrink-0 text-ui-accent" aria-hidden="true" />
        <span class="min-w-0 flex-1"><span class="block text-sm">{{ t("team.join") }}</span><span class="mt-0.5 block text-[13px] text-ui-text-muted">{{ t("team.joinDescription") }}</span></span>
        <ChevronRight :size="16" class="shrink-0 text-ui-text-faint" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
