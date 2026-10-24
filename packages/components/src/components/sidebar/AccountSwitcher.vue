<script setup lang="ts">
import { Check, ChevronDown, ChevronsUpDown, Laptop, Monitor, Plus, RefreshCw, Settings, UserPlus, Users } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { useAccountContext } from "../../composables/useAccountContext.ts"
import MenuPopover from "../common/MenuPopover.vue"

const { t } = useI18n()
const context = useAccountContext()
const team = computed(() => context?.team.value)
const machine = computed(() => context?.machines.value.find(value => value.id === context.machineId.value))
const row = "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-ui-hover focus:bg-ui-hover disabled:cursor-default disabled:op-50"
</script>

<template>
  <div v-if="context" class="mb-3 flex shrink-0 flex-col gap-0.5 px-2" data-account-switcher>
    <MenuPopover :label="t('account.team')" :disabled="context.busy.value">
      <template #trigger>
        <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-ui-border bg-ui-surface"><Users :size="14" :stroke-width="1.75" aria-hidden="true" /></span>
        <span class="min-w-0 flex-1 truncate font-medium">{{ team?.name ?? t('account.team') }}</span>
        <ChevronsUpDown :size="14" class="shrink-0 text-ui-text-faint" aria-hidden="true" />
      </template>
      <template #default="{ close }">
        <div class="px-2.5 py-2 text-xs text-ui-text-faint">{{ t('account.team') }}</div>
        <button v-for="item in context.teams.value" :key="item.id" type="button" role="menuitemradio" tabindex="-1" :aria-checked="item.id === context.teamId.value" :data-team-id="item.id" :class="row" @click="close(); context.selectTeam(item.id)"><span class="min-w-0 flex-1 truncate">{{ item.name }}</span><Check v-if="item.id === context.teamId.value" :size="14" aria-hidden="true" /></button>
        <div role="separator" class="my-1 border-t border-ui-border" />
        <button v-if="team" type="button" role="menuitem" tabindex="-1" :class="row" @click="close(); context.manageTeam()"><Settings :size="15" aria-hidden="true" />{{ t('account.teamSettings') }}</button>
        <button type="button" role="menuitem" tabindex="-1" :class="row" @click="close(); context.createTeam()"><Plus :size="15" aria-hidden="true" />{{ t('account.createTeam') }}</button>
        <button type="button" role="menuitem" tabindex="-1" :class="row" @click="close(); context.joinTeam()"><UserPlus :size="15" aria-hidden="true" />{{ t('account.joinTeam') }}</button>
      </template>
    </MenuPopover>
    <MenuPopover v-if="team" :label="t('account.machine')" :disabled="context.busy.value">
      <template #trigger>
        <Monitor :size="16" :stroke-width="1.75" class="ml-1 shrink-0 text-ui-text-muted" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate text-ui-text-muted">{{ machine?.name ?? t('account.chooseMachine') }}</span>
        <span v-if="machine" class="h-1.5 w-1.5 shrink-0 rounded-full" :class="machine.online ? 'bg-ui-success' : 'bg-ui-text-faint'" aria-hidden="true" />
        <ChevronDown :size="13" class="shrink-0 text-ui-text-faint" aria-hidden="true" />
      </template>
      <template #default="{ close }">
        <div class="px-2.5 py-2 text-xs text-ui-text-faint">{{ t('account.machine') }}</div>
        <button v-for="item in context.machines.value" :key="item.id" type="button" role="menuitemradio" tabindex="-1" :aria-checked="item.id === context.machineId.value" :data-machine-id="item.id" :class="row" @click="close(); context.selectMachine(item.id)">
          <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="item.online ? 'bg-ui-success' : 'bg-ui-text-faint'" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate">{{ item.name }}</span><span v-if="!item.online" class="text-xs text-ui-text-faint">{{ t('machine.offline') }}</span><Check v-if="item.id === context.machineId.value" :size="14" aria-hidden="true" />
        </button>
        <div role="separator" class="my-1 border-t border-ui-border" />
        <button v-if="context.central.enrollLocal && context.canEnroll.value" type="button" role="menuitem" tabindex="-1" :class="row" @click="close(); context.enrollLocal()"><Laptop :size="15" class="shrink-0" aria-hidden="true" /><span>{{ t(context.enrollment.value?.revoked ? 'account.reenrollThisMachine' : 'account.enrollThisMachine') }}</span></button>
        <button type="button" role="menuitem" tabindex="-1" :class="row" @click="close(); context.enrollHeadless()"><Plus :size="15" aria-hidden="true" />{{ t('account.enrollHeadless') }}</button>
        <button type="button" role="menuitem" tabindex="-1" :class="row" @click="close(); context.refresh()"><RefreshCw :size="15" aria-hidden="true" />{{ t('catalog.refresh') }}</button>
      </template>
    </MenuPopover>
    <p v-if="!context.connected.value" role="status" class="m-0 px-2.5 py-2 text-xs text-ui-warning">{{ t('account.signalingOffline') }}</p>
    <p v-if="context.enrollment.value?.revoked" role="status" class="m-0 px-2.5 py-2 text-xs text-ui-text-muted">{{ t('account.enrollmentRevoked') }}</p>
    <p v-if="context.error.value" role="alert" class="m-0 break-words px-2.5 py-2 text-xs text-ui-danger">{{ context.error.value }}</p>
  </div>
</template>
