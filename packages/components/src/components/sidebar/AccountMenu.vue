<script setup lang="ts">
import { ChevronUp, LogOut, ShieldCheck } from "@lucide/vue"
import { DropdownMenuItem } from "reka-ui"
import { useI18n } from "vue-i18n"
import { client } from "@deskfleet/client/platform"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { router } from "../../router/index.ts"
import MenuPopover from "../common/MenuPopover.vue"
import UserAvatar from "../common/UserAvatar.vue"

const session = useAccountSession()
const { t } = useI18n()

function signOut(): void {
  session!.signOut().catch((reason: unknown) => { session!.notice.value = reason instanceof Error ? reason.message : String(reason) })
}
</script>

<template>
  <MenuPopover v-if="session?.account.value.user" :label="session.account.value.user.name" placement="top" class="min-w-0 flex-1">
    <template #trigger>
      <UserAvatar :name="session.account.value.user.name" :email="session.account.value.user.email" :size="24" class="text-xs" />
      <span class="min-w-0 flex-1 truncate">{{ session.account.value.user.name }}</span>
      <ChevronUp :size="13" class="shrink-0 text-ui-text-faint" aria-hidden="true" />
    </template>
    <template #default>
      <div class="border-b border-ui-border px-2.5 py-2.5">
        <div class="truncate text-[13px] font-medium">{{ session.account.value.user.name }}</div>
        <div v-if="session.account.value.user.email" class="mt-0.5 truncate text-xs text-ui-text-muted">{{ session.account.value.user.email }}</div>
        <div class="mt-0.5 truncate text-xs text-ui-text-faint">{{ session.account.value.serverUrl }}</div>
        <div v-if="session.site.value" class="mt-0.5 truncate text-xs text-ui-text-muted">{{ session.site.value.siteName }}</div>
      </div>
      <DropdownMenuItem v-if="client.platform === 'web' && client.siteAdministration && session.account.value.siteAdmin" as="button" type="button" class="ui-menu-item mt-1" @select="router.push({ name: 'site-admin' })"><ShieldCheck :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("siteAdmin.title") }}</DropdownMenuItem>
      <DropdownMenuItem as="button" type="button" class="ui-menu-item mt-1" @select="signOut"><LogOut :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("account.signOut") }}</DropdownMenuItem>
    </template>
  </MenuPopover>
</template>
