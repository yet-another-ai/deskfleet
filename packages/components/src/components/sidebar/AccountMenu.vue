<script setup lang="ts">
import { Check, ChevronsUpDown, CreditCard, Gauge, KeyRound, LogOut, Plus, Settings, ShieldCheck, UserPlus } from "@lucide/vue"
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from "reka-ui"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useTeamBilling } from "../../composables/useTeamBilling.ts"
import { router } from "../../router/index.ts"
import { trackEvent } from "../../services/analytics.ts"
import MenuPopover from "../common/MenuPopover.vue"
import UserAvatar from "../common/UserAvatar.vue"

const client = usePlatformClient()
const session = useAccountSession()
const { t } = useI18n()
const { billing } = useTeamBilling(session)

const planLabel = computed(() => billing.value ? t(`billing.plan.${billing.value.plan}`) : undefined)
const triggerLabel = computed(() => {
  const user = session?.account.value.user?.name ?? ""
  const team = session?.team.value?.name
  return team ? `${team} · ${user}` : user
})

function showTeamDialog(mode: "create-team" | "join-team"): void {
  if (session) session.dialog.value = mode
}

function openBilling(): void {
  if (!session) return
  if (!client.mobile) trackEvent("billing_entry_clicked", { source: "team_menu", current_plan: billing.value?.plan, action: "view" })
  session.openSettings("plans")
}

function security(): void {
  session!.central.openAccountSettings().catch((reason: unknown) => { session!.notice.value = reason instanceof Error ? reason.message : String(reason) })
}

function signOut(): void {
  session!.signOut().catch((reason: unknown) => { session!.notice.value = reason instanceof Error ? reason.message : String(reason) })
}
</script>

<template>
  <MenuPopover v-if="session?.account.value.user" :label="triggerLabel" placement="top" class="min-w-0 flex-1" trigger-class="h-10 py-1" data-account-menu>
    <template #trigger>
      <UserAvatar :name="session.account.value.user.name" :email="session.account.value.user.email" :size="26" class="text-xs" />
      <span class="flex min-w-0 flex-1 flex-col text-left leading-tight">
        <span class="flex min-w-0 items-center gap-1.5">
          <span class="min-w-0 truncate text-[13px] font-medium text-ui-text">{{ session.team.value?.name ?? session.account.value.user.name }}</span>
          <span v-if="planLabel && session.team.value" data-team-plan-badge class="shrink-0 rounded bg-ui-hover px-1.5 py-0.5 text-[10px] font-medium leading-none text-ui-text-muted">{{ planLabel }}</span>
        </span>
        <span v-if="session.team.value" class="truncate text-[11px] text-ui-text-faint">{{ session.account.value.user.name }}</span>
      </span>
      <ChevronsUpDown :size="13" class="shrink-0 text-ui-text-faint" aria-hidden="true" />
    </template>
    <template #default="{ openDialog }">
      <div class="-mx-1 border-b border-ui-border px-3.5 py-2.5">
        <div class="truncate text-[13px] font-medium">{{ session.account.value.user.name }}</div>
        <div v-if="session.account.value.user.email" class="mt-0.5 truncate text-xs text-ui-text-muted">{{ session.account.value.user.email }}</div>
        <div class="mt-0.5 truncate text-xs text-ui-text-faint">{{ session.account.value.serverUrl }}</div>
        <div v-if="session.site.value" class="mt-0.5 truncate text-xs text-ui-text-muted">{{ session.site.value.siteName }}</div>
      </div>

      <template v-if="session.teams.value.length">
        <DropdownMenuLabel class="px-2.5 pt-2 pb-1 text-xs text-ui-text-faint">{{ t("team.teams") }}</DropdownMenuLabel>
        <DropdownMenuRadioGroup :model-value="session.teamId.value ?? undefined">
          <DropdownMenuRadioItem v-for="team in session.teams.value" :key="team.id" as="button" type="button" :value="team.id" :data-team-id="team.id" class="ui-menu-item" @select="session.selectTeam(team.id)">
            <span class="min-w-0 flex-1 truncate">{{ team.name }}</span>
            <Check v-if="team.id === session.teamId.value" :size="14" class="shrink-0" aria-hidden="true" />
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator class="-mx-1 my-1 border-t border-ui-border" />
      </template>

      <DropdownMenuItem v-if="session.team.value" as="button" type="button" class="ui-menu-item" @select="session.openSettings('team')"><Settings :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("team.settings") }}</DropdownMenuItem>
      <DropdownMenuItem v-if="session.team.value" as="button" type="button" class="ui-menu-item" @select="openBilling"><component :is="client.mobile ? Gauge : CreditCard" :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t(client.mobile ? "team.usage" : "billing.plansAndBilling") }}</DropdownMenuItem>
      <DropdownMenuItem v-if="session.site.value?.allowTeamCreation" as="button" type="button" class="ui-menu-item" @select="openDialog(() => showTeamDialog('create-team'))"><Plus :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("team.create") }}</DropdownMenuItem>
      <DropdownMenuItem as="button" type="button" class="ui-menu-item" @select="openDialog(() => showTeamDialog('join-team'))"><UserPlus :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("team.join") }}</DropdownMenuItem>

      <DropdownMenuSeparator class="-mx-1 my-1 border-t border-ui-border" />
      <DropdownMenuItem as="button" type="button" class="ui-menu-item" @select="security"><KeyRound :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("auth.security") }}</DropdownMenuItem>
      <DropdownMenuItem v-if="client.platform === 'web' && client.siteAdministration && session.account.value.siteAdmin" as="button" type="button" class="ui-menu-item" @select="router.push({ name: 'site-admin' })"><ShieldCheck :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("siteAdmin.title") }}</DropdownMenuItem>
      <DropdownMenuItem as="button" type="button" class="ui-menu-item" @select="signOut"><LogOut :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("account.signOut") }}</DropdownMenuItem>
    </template>
  </MenuPopover>
</template>
