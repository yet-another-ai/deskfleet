<script setup lang="ts">
import { Check, ChevronsUpDown, Plus, Settings, UserPlus } from "@lucide/vue"
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from "reka-ui"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import MenuPopover from "../common/MenuPopover.vue"

const { t } = useI18n()
const session = useAccountSession()
function showTeamDialog(mode: "create-team" | "join-team"): void {
  if (session) session.dialog.value = mode
}
</script>

<template>
  <div v-if="session" class="mb-2 shrink-0 px-2">
    <MenuPopover :label="t('team.label')">
      <template #trigger>
        <span class="ui-avatar h-6 w-6 rounded-md" aria-hidden="true">{{ session.team.value?.name.charAt(0).toUpperCase() ?? "?" }}</span>
        <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ session.team.value?.name ?? t("team.none") }}</span>
        <ChevronsUpDown :size="14" class="shrink-0 text-ui-text-faint" aria-hidden="true" />
      </template>
      <template #default="{ openDialog }">
        <DropdownMenuLabel class="px-2.5 pt-1.5 pb-1 text-xs text-ui-text-faint">{{ t("team.teams") }}</DropdownMenuLabel>
        <DropdownMenuRadioGroup :model-value="session.teamId.value ?? undefined">
          <DropdownMenuRadioItem v-for="team in session.teams.value" :key="team.id" as="button" type="button" :value="team.id" :data-team-id="team.id" class="ui-menu-item" @select="session.selectTeam(team.id)">
            <span class="min-w-0 flex-1 truncate">{{ team.name }}</span>
            <Check v-if="team.id === session.teamId.value" :size="14" class="shrink-0" aria-hidden="true" />
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator class="my-1 border-t border-ui-border" />
        <DropdownMenuItem v-if="session.team.value" as="button" type="button" class="ui-menu-item" @select="session.openSettings('team')"><Settings :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("team.settings") }}</DropdownMenuItem>
        <DropdownMenuItem v-if="session.site.value?.allowTeamCreation" as="button" type="button" class="ui-menu-item" @select="openDialog(() => showTeamDialog('create-team'))"><Plus :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("team.create") }}</DropdownMenuItem>
        <DropdownMenuItem as="button" type="button" class="ui-menu-item" @select="openDialog(() => showTeamDialog('join-team'))"><UserPlus :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("team.join") }}</DropdownMenuItem>
      </template>
    </MenuPopover>
  </div>
</template>
