<script setup lang="ts">
import { LayoutGrid, LocateFixed, MonitorPlay, Plus, RefreshCw, SquareTerminal, Unplug } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { RouterLink, useRoute, useRouter } from "vue-router"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { machineOrderGroup, useSidebarOrder } from "../../composables/useSidebarOrder.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import UiButton from "../common/UiButton.vue"
import UiScrollArea from "../common/UiScrollArea.vue"
import MachineBatteryIndicator from "./MachineBatteryIndicator.vue"

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const account = useAccountSession()
const fleet = useFleetStore()
const sidebarOrder = useSidebarOrder()

const machines = computed(() => {
  if (account) {
    return sidebarOrder.ordered(machineOrderGroup, account.machines.value.filter(m => m.teamId === account.teamId.value)).map(m => ({
      id: m.id,
      name: m.name,
      online: m.online,
      local: m.id === account.localMachineId.value,
      desktop: m.capabilities.desktop === true,
    }))
  }
  return sidebarOrder.ordered(machineOrderGroup, fleet.machines).map(m => ({
    id: m.id,
    name: m.name,
    online: m.online,
    local: m.local,
    desktop: m.desktop,
  }))
})

function isActiveMachine(machineId: string): boolean {
  return route.name === "machine-control" && route.params.machineId === machineId
    && (!account || account.machineId.value === machineId)
}

function openMachine(machine: { id: string; local: boolean; desktop: boolean }): void {
  const destination = {
    name: "machine-control",
    params: { machineId: machine.id },
    ...(!machine.local && machine.desktop ? { query: { tab: "desktop" } } : {}),
  }
  if (account) account.openMachineRoute(machine.id, destination)
  else void router.push(destination)
}
</script>

<template>
  <div role="tabpanel" aria-labelledby="sidebar-tab-desktops" data-sidebar-panel="desktops" class="flex min-h-0 flex-1 flex-col">
    <div class="shrink-0 px-2 pb-2">
      <RouterLink
        :to="{ name: 'remote-desktops' }"
        class="ui-nav-item px-2.5"
        exact-active-class="ui-nav-active"
      >
        <LayoutGrid :size="16" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
        <span class="truncate">{{ t("desktopOverview.allMachines") }}</span>
      </RouterLink>
    </div>

    <UiScrollArea class="min-h-0 min-w-0 flex-1" viewport-class="overscroll-contain" content-class="px-2 pb-3">
      <div class="mb-2 flex items-center justify-between gap-2 pl-2.5 pr-1 text-xs text-ui-text-faint">
        <span>{{ t("catalog.machines") }}</span>
        <div class="flex shrink-0 items-center gap-0.5">
          <UiButton
            v-if="account"
            variant="ghost"
            size="icon"
            class="!h-6 !w-6 rounded-md text-ui-text-faint [&:not(:disabled,[aria-disabled=true])]:hover:bg-ui-text/8 [&:not(:disabled,[aria-disabled=true])]:hover:text-ui-text"
            :label="t('catalog.refresh')"
            @click="account.refreshMachines()"
          >
            <RefreshCw :size="14" :stroke-width="1.75" aria-hidden="true" />
          </UiButton>
          <UiButton
            v-if="account"
            variant="ghost"
            size="icon"
            class="!h-6 !w-6 rounded-md text-ui-text-faint [&:not(:disabled,[aria-disabled=true])]:hover:bg-ui-text/8 [&:not(:disabled,[aria-disabled=true])]:hover:text-ui-text"
            :label="t('account.addMachine')"
            @click="account.dialog.value = 'add-machine'"
          >
            <Plus :size="14" :stroke-width="1.75" aria-hidden="true" />
          </UiButton>
        </div>
      </div>

      <ul v-if="machines.length" class="m-0 flex list-none flex-col gap-1 p-0">
        <li v-for="machine in machines" :key="machine.id">
          <button
            type="button"
            class="ui-nav-item w-full px-2.5 text-left"
            :class="isActiveMachine(machine.id) && 'ui-nav-active'"
            :aria-current="isActiveMachine(machine.id) ? 'page' : undefined"
            @click="openMachine(machine)"
          >
            <component :is="machine.local ? SquareTerminal : MonitorPlay" :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate">{{ machine.name }}</span>
            <LocateFixed v-if="machine.local" :size="13" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" :title="t('machine.local')" aria-hidden="true" />
            <MachineBatteryIndicator :machine-id="machine.id" :online="machine.online" />
            <span v-if="!machine.online" class="inline-flex shrink-0 items-center text-ui-warning" :title="t('machine.offline')">
              <Unplug :size="14" :stroke-width="1.75" aria-hidden="true" />
              <span class="sr-only">{{ t("machine.offline") }}</span>
            </span>
          </button>
        </li>
      </ul>
      <p v-else class="mx-2.5 mt-2 text-xs text-ui-text-faint">{{ t("desktopOverview.empty") }}</p>
    </UiScrollArea>
  </div>
</template>
