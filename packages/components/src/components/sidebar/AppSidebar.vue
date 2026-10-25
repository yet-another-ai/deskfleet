<script setup lang="ts">
import { client as platformClient } from "@deskfleet/client/platform"

import { Plus, SquarePen } from "@lucide/vue"
import { storeToRefs } from "pinia"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import WindowToolbar from "../chrome/WindowToolbar.vue"
import IconButton from "../common/IconButton.vue"
import AccountNotices from "./AccountNotices.vue"
import MachineSection from "./MachineSection.vue"
import SidebarFooter from "./SidebarFooter.vue"
import SidebarLink from "./SidebarLink.vue"
import TeamMachineRow from "./TeamMachineRow.vue"
import TeamSwitcher from "./TeamSwitcher.vue"

const { t } = useI18n()
const fleet = useFleetStore()
const account = useAccountSession()
const { machines, catalogError, catalogLoading } = storeToRefs(fleet)
const platform = platformClient.platform
// With an account, this application scope holds only the selected machine's catalog.
const loaded = (id: string) => machines.value.find(machine => machine.id === id)

function refresh(): void {
  void fleet.refreshLocal()
  void account?.refreshMachines()
}
</script>

<template>
  <aside class="flex w-65 shrink-0 flex-col border-r border-ui-border bg-ui-sidebar">
    <!-- On macOS the traffic lights sit at the start of this row. -->
    <div
      class="app-drag flex h-12 shrink-0 items-center justify-end pr-2"
      :class="platform === 'darwin' ? 'pl-20' : 'pl-2'"
    >
      <WindowToolbar />
    </div>

    <TeamSwitcher />

    <nav :aria-label="t('nav.label')" class="flex shrink-0 flex-col gap-0.5 px-2">
      <SidebarLink :to="{ name: 'new-session' }" :icon="SquarePen" :label="t('nav.newSession')" />
    </nav>

    <div class="mt-4 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      <div class="mb-2 flex items-center justify-between gap-2 px-2.5 text-xs text-ui-text-faint">
        <span>{{ catalogLoading ? t("catalog.loading") : t("catalog.workspaces") }}</span>
        <div class="-mr-1.5 flex items-center">
          <button type="button" class="cursor-pointer rounded px-1 py-1 hover:bg-ui-hover disabled:op-40" :disabled="catalogLoading" @click="refresh">{{ t("catalog.refresh") }}</button>
          <IconButton v-if="account" :icon="Plus" :label="t('account.addMachine')" @click="account.dialog.value = 'add-machine'" />
        </div>
      </div>
      <p v-if="catalogError" role="alert" class="mx-2.5 mb-3 break-words text-xs text-ui-danger">{{ catalogError }}</p>
      <template v-if="account">
        <template v-for="machine in account.machines.value" :key="machine.id">
          <MachineSection v-if="loaded(machine.id)" :machine="loaded(machine.id)!" />
          <TeamMachineRow v-else :machine="machine" @select="account.selectMachine(machine.id)" />
        </template>
      </template>
      <MachineSection v-for="machine in machines" v-else :key="machine.id" :machine="machine" />
    </div>

    <AccountNotices />
    <SidebarFooter />
  </aside>
</template>
