<script setup lang="ts">
import { client as platformClient } from "@deskfleet/client/platform"

import { Plus } from "@lucide/vue"
import { useEventListener } from "@vueuse/core"
import { storeToRefs } from "pinia"
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import WindowToolbar from "../chrome/WindowToolbar.vue"
import IconButton from "../common/IconButton.vue"
import AccountNotices from "./AccountNotices.vue"
import MachineSection from "./MachineSection.vue"
import SidebarFooter from "./SidebarFooter.vue"
import SidebarNavigation from "./SidebarNavigation.vue"
import TeamMachineRow from "./TeamMachineRow.vue"
import TeamSwitcher from "./TeamSwitcher.vue"

const { t } = useI18n()
const fleet = useFleetStore()
const account = useAccountSession()
const { sidebarWidth } = storeToRefs(useLayoutStore())
const { machines, catalogError, catalogLoading } = storeToRefs(fleet)
const platform = platformClient.platform
// With an account, this application scope holds only the selected machine's catalog.
const loaded = (id: string) => machines.value.find(machine => machine.id === id)
const minimum = 200
const maximum = 480
const clamp = (width: number) => Math.round(Math.min(Math.max(width, minimum), maximum))
const width = computed(() => clamp(sidebarWidth.value))
const resizing = ref<{ startX: number; startWidth: number } | null>(null)

function startResize(event: PointerEvent): void {
  resizing.value = { startX: event.clientX, startWidth: width.value }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
useEventListener("pointermove", (event: PointerEvent) => {
  if (resizing.value) sidebarWidth.value = clamp(resizing.value.startWidth + event.clientX - resizing.value.startX)
})
useEventListener(["pointerup", "pointercancel"], () => { resizing.value = null })
function keyResize(event: KeyboardEvent): void {
  const step = event.shiftKey ? 64 : 16
  if (event.key === "ArrowRight") sidebarWidth.value = clamp(width.value + step)
  else if (event.key === "ArrowLeft") sidebarWidth.value = clamp(width.value - step)
  else return
  event.preventDefault()
}

function refresh(): void {
  void fleet.refreshLocal()
  void account?.refreshMachines()
}
</script>

<template>
  <aside
    class="relative flex shrink-0 flex-col border-r border-ui-border bg-ui-sidebar"
    :style="{ width: `${width}px` }"
  >
    <div
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      :aria-label="t('toolbar.resizeSidebar')"
      :aria-valuenow="width"
      :aria-valuemin="minimum"
      :aria-valuemax="maximum"
      class="app-no-drag absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize after:pointer-events-none after:absolute after:inset-y-0 after:left-3.5px after:w-0.5 after:bg-transparent after:transition-colors after:duration-125 after:ease-out after:content-[''] hover:after:bg-ui-focus/50 focus-visible:after:bg-ui-focus/50"
      :class="resizing && 'after:!bg-ui-focus/50'"
      @pointerdown="startResize"
      @keydown="keyResize"
    />
    <!-- On macOS the traffic lights sit at the start of this row. -->
    <div
      class="app-drag flex h-12 shrink-0 items-center justify-end pr-2"
      :class="platform === 'darwin' ? 'pl-20' : 'pl-2'"
    >
      <WindowToolbar />
    </div>

    <TeamSwitcher />

    <SidebarNavigation />

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
