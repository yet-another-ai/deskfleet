<script setup lang="ts">
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import type { Machine } from "@deskfleet/client/central"
import type { MachineSummary } from "../../stores/fleet-types.ts"

import { Plus } from "@lucide/vue"
import { useEventListener } from "@vueuse/core"
import { storeToRefs } from "pinia"
import { ToggleGroupItem, ToggleGroupRoot } from "reka-ui"
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useMachineRuntimes } from "../../composables/useMachineRuntimes.ts"
import { useSidebarFilter, type SidebarSessionFilter } from "../../composables/useSidebarFilter.ts"
import { machineOrderGroup, useSidebarOrder } from "../../composables/useSidebarOrder.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import WindowToolbar from "../chrome/WindowToolbar.vue"
import UiButton from "../common/UiButton.vue"
import UiScrollArea from "../common/UiScrollArea.vue"
import AccountNotices from "./AccountNotices.vue"
import AppUpdateNotice from "./AppUpdateNotice.vue"
import MachineSection from "./MachineSection.vue"
import MachineSidebarSurface from "./MachineSidebarSurface.vue"
import PinnedSessions from "./PinnedSessions.vue"
import ProviderUpdateNotice from "./ProviderUpdateNotice.vue"
import SidebarFooter from "./SidebarFooter.vue"
import SidebarNavigation from "./SidebarNavigation.vue"
import TeamSwitcher from "./TeamSwitcher.vue"

const { t } = useI18n()
const platformClient = usePlatformClient()
const fleet = useFleetStore()
const account = useAccountSession()
const runtimes = useMachineRuntimes()
const sidebarFilter = useSidebarFilter()
const filterOptions = computed<{ id: SidebarSessionFilter; label: string; count?: number }[]>(() => [
  { id: "all", label: t("sidebar.filterAll") },
  { id: "unread", label: t("sidebar.filterUnread"), count: sidebarFilter.totalUnread.value },
  { id: "working", label: t("sidebar.filterWorking"), count: sidebarFilter.totalWorking.value },
])
const filterEmpty = computed(() =>
  sidebarFilter.filter.value === "unread" && sidebarFilter.totalUnread.value === 0
  || sidebarFilter.filter.value === "working" && sidebarFilter.totalWorking.value === 0,
)
const { compact, sidebarWidth } = storeToRefs(useLayoutStore())
const scrollArea = useTemplateRef<InstanceType<typeof UiScrollArea>>("scrollArea")
onMounted(() => {
  const el = scrollArea.value?.viewportElement
  if (runtimes?.sidebarScrollTop && el) el.scrollTop = runtimes.sidebarScrollTop
})
onBeforeUnmount(() => {
  const el = scrollArea.value?.viewportElement
  if (runtimes && el) runtimes.sidebarScrollTop = el.scrollTop
})
const { machines, catalogError, catalogLoading } = storeToRefs(fleet)
const sidebarOrder = useSidebarOrder()
const accountMachines = computed(() => sidebarOrder.ordered(machineOrderGroup, account?.machines.value ?? []))
const localMachines = computed(() => sidebarOrder.ordered(machineOrderGroup, machines.value))
const platform = platformClient.platform
// Each opened machine retains its own catalog and action scope.
const loaded = (id: string) => machines.value.find(machine => machine.id === id)
const unopened = (machine: Machine): MachineSummary => ({
  id: machine.id,
  name: machine.name,
  local: machine.id === account?.localMachineId.value,
  online: machine.online,
  lastSeen: machine.lastSeenAt ?? undefined,
  desktop: machine.capabilities.desktop === true,
  terminals: [],
  sessions: [],
  workspaces: [],
})
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
  if (runtimes) for (const runtime of runtimes.opened.values()) runtime.refreshCatalog()
  else void fleet.refreshLocal()
  void account?.refreshMachines()
}
</script>

<template>
  <aside
    class="relative flex shrink-0 flex-col overflow-y-clip border-r border-ui-border bg-ui-sidebar"
    :style="{ width: compact ? '100%' : `${width}px` }"
  >
    <!-- On macOS the traffic lights sit at the start of this row. -->
    <div
      v-if="!compact"
      class="app-drag flex h-12 shrink-0 items-center justify-end pr-2"
      :class="platform === 'darwin' ? 'pl-20' : 'pl-2'"
    >
      <WindowToolbar :sidebar="compact" />
    </div>

    <TeamSwitcher />

    <SidebarNavigation />

    <div class="app-no-drag shrink-0 border-b border-ui-border px-4 pt-2.5">
      <ToggleGroupRoot :model-value="sidebarFilter.filter.value" type="single" :aria-label="t('sidebar.filterLabel')" class="flex items-center gap-4" @update:model-value="value => value && (sidebarFilter.filter.value = value as SidebarSessionFilter)">
        <ToggleGroupItem v-for="option in filterOptions" :key="option.id" :value="option.id" :data-sidebar-filter="option.id" class="ui-tab gap-1 pb-2 text-xs font-medium" :class="sidebarFilter.filter.value === option.id && 'ui-tab-active'">
          <span>{{ option.label }}</span>
          <span v-if="option.count && option.count > 0" class="tabular-nums text-[11px] opacity-70">{{ option.count }}</span>
        </ToggleGroupItem>
      </ToggleGroupRoot>
    </div>

    <UiScrollArea
      ref="scrollArea"
      class="min-h-0 min-w-0 flex-1"
      content-class="px-2 pt-3 pb-3"
      data-sidebar-scroll-area
      :viewport-attrs="{ 'data-sidebar-scroll-viewport': '' }"
    >
      <PinnedSessions />
      <div class="mb-2 flex items-center justify-between gap-2 px-2.5 text-xs text-ui-text-faint">
        <span>{{ catalogLoading ? t("catalog.loading") : t("catalog.workspaces") }}</span>
        <div class="-mr-1.5 flex items-center">
          <button type="button" class="cursor-pointer rounded px-1 py-1 ui-motion hover:bg-ui-hover disabled:op-40" :disabled="catalogLoading" @click="refresh">{{ t("catalog.refresh") }}</button>
          <UiButton v-if="account" variant="ghost" size="icon" :label="t('account.addMachine')" @click="account.dialog.value = 'add-machine'"><Plus :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
        </div>
      </div>
      <p v-if="catalogError" role="alert" class="mx-2.5 mb-3 break-words text-xs text-ui-danger">{{ catalogError }}</p>
      <template v-if="account">
        <template v-for="machine in accountMachines" :key="machine.id">
          <MachineSection v-if="loaded(machine.id)" :machine="loaded(machine.id)!" />
          <MachineSidebarSurface v-else-if="runtimes?.opened.has(machine.id)" :runtime="runtimes.opened.get(machine.id)!" />
          <MachineSection v-else :machine="unopened(machine)" />
        </template>
      </template>
      <MachineSection v-for="machine in localMachines" v-else :key="machine.id" :machine="machine" />
      <div v-if="filterEmpty" class="mx-2.5 mt-4 flex flex-col items-start gap-1.5 text-xs text-ui-text-faint">
        <p class="m-0">{{ t(sidebarFilter.filter.value === 'unread' ? 'sidebar.filterEmptyUnread' : 'sidebar.filterEmptyWorking') }}</p>
        <button type="button" class="cursor-pointer rounded text-ui-accent hover:underline" @click="sidebarFilter.filter.value = 'all'">{{ t('sidebar.showAllSessions') }}</button>
      </div>
    </UiScrollArea>

    <AccountNotices />
    <ProviderUpdateNotice />
    <AppUpdateNotice />
    <SidebarFooter />

    <div
      v-if="!compact"
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      :aria-label="t('toolbar.resizeSidebar')"
      :aria-valuenow="width"
      :aria-valuemin="minimum"
      :aria-valuemax="maximum"
      class="ui-sash app-no-drag absolute inset-y-0 -right-1 z-30 w-2 cursor-col-resize outline-none"
      :class="resizing && 'ui-sash-active'"
      @pointerdown="startResize"
      @keydown="keyResize"
    />
  </aside>
</template>
