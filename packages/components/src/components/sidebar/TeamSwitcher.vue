<script setup lang="ts">
import { Check, ChevronsUpDown, Plus, Settings, UserPlus } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import MenuPopover from "../common/MenuPopover.vue"

const { t } = useI18n()
const session = useAccountSession()
const item = "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-ui-hover focus:bg-ui-hover"
</script>

<template>
  <div v-if="session" class="mb-2 shrink-0 px-2">
    <MenuPopover :label="t('team.label')">
      <template #trigger>
        <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-ui-avatar text-xs font-semibold text-white" aria-hidden="true">{{ session.team.value?.name.charAt(0).toUpperCase() ?? "?" }}</span>
        <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ session.team.value?.name ?? t("team.none") }}</span>
        <ChevronsUpDown :size="14" class="shrink-0 text-ui-text-faint" aria-hidden="true" />
      </template>
      <template #default="{ close }">
        <div class="px-2.5 pt-1.5 pb-1 text-xs text-ui-text-faint">{{ t("team.teams") }}</div>
        <button v-for="team in session.teams.value" :key="team.id" type="button" role="menuitemradio" tabindex="-1" :aria-checked="team.id === session.teamId.value" :data-team-id="team.id" :class="item" @click="close(); session.selectTeam(team.id)">
          <span class="min-w-0 flex-1 truncate">{{ team.name }}</span>
          <Check v-if="team.id === session.teamId.value" :size="14" class="shrink-0" aria-hidden="true" />
        </button>
        <div role="separator" class="my-1 border-t border-ui-border" />
        <button v-if="session.team.value" type="button" role="menuitem" tabindex="-1" :class="item" @click="close(); session.openSettings('team')"><Settings :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("team.settings") }}</button>
        <button type="button" role="menuitem" tabindex="-1" :class="item" @click="close(); session.dialog.value = 'create-team'"><Plus :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("team.create") }}</button>
        <button type="button" role="menuitem" tabindex="-1" :class="item" @click="close(); session.dialog.value = 'join-team'"><UserPlus :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("team.join") }}</button>
      </template>
    </MenuPopover>
  </div>
</template>
