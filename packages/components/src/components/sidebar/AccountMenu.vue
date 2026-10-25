<script setup lang="ts">
import { ChevronUp, LogOut } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import MenuPopover from "../common/MenuPopover.vue"

const session = useAccountSession()
const { t } = useI18n()

function signOut(): void {
  session!.signOut().catch((reason: unknown) => { session!.notice.value = reason instanceof Error ? reason.message : String(reason) })
}
</script>

<template>
  <MenuPopover v-if="session?.account.value.user" :label="session.account.value.user.name" placement="top" class="min-w-0 flex-1">
    <template #trigger>
      <span class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ui-badge text-xs font-semibold text-ui-text-muted" aria-hidden="true">{{ session.account.value.user.name.charAt(0).toUpperCase() }}</span>
      <span class="min-w-0 flex-1 truncate">{{ session.account.value.user.name }}</span>
      <ChevronUp :size="13" class="shrink-0 text-ui-text-faint" aria-hidden="true" />
    </template>
    <template #default="{ close }">
      <div class="border-b border-ui-border px-2.5 py-2.5">
        <div class="truncate text-[13px] font-medium">{{ session.account.value.user.name }}</div>
        <div v-if="session.account.value.user.email" class="mt-0.5 truncate text-xs text-ui-text-muted">{{ session.account.value.user.email }}</div>
        <div class="mt-0.5 truncate text-xs text-ui-text-faint">{{ session.account.value.serverUrl }}</div>
      </div>
      <button type="button" role="menuitem" tabindex="-1" class="ui-menu-item mt-1" @click="close(); signOut()"><LogOut :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("account.signOut") }}</button>
    </template>
  </MenuPopover>
</template>
