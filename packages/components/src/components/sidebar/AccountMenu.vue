<script setup lang="ts">
import { ChevronUp, LogOut } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { useAccountContext } from "../../composables/useAccountContext.ts"
import MenuPopover from "../common/MenuPopover.vue"

const context = useAccountContext()
const { t } = useI18n()
</script>

<template>
  <MenuPopover v-if="context?.account.value.user" :label="context.account.value.user.name" :disabled="context.busy.value" placement="top" class="min-w-0 flex-1">
    <template #trigger>
      <span class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-ui-avatar text-xs font-semibold text-white" aria-hidden="true">{{ context.account.value.user.name.charAt(0).toUpperCase() }}</span>
      <span class="min-w-0 flex-1 truncate">{{ context.account.value.user.name }}</span>
      <ChevronUp :size="13" class="shrink-0 text-ui-text-faint" aria-hidden="true" />
    </template>
    <template #default="{ close }">
      <div class="border-b border-ui-border px-2.5 py-2.5"><div class="truncate text-[13px] font-medium">{{ context.account.value.user.name }}</div><div class="mt-1 truncate text-xs text-ui-text-muted">{{ context.account.value.user.email }}</div></div>
      <button type="button" role="menuitem" tabindex="-1" class="mt-1 flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-ui-hover focus:bg-ui-hover" @click="close(); context.logout()"><LogOut :size="15" aria-hidden="true" />{{ t('account.signOut') }}</button>
    </template>
  </MenuPopover>
</template>
