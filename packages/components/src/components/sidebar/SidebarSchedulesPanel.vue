<script setup lang="ts">
import { withCentralRequestTrigger } from "@deskfleet/client/reporting-central"
import { schedulesClient, type ScheduledTask } from "@deskfleet/client/schedules"
import { CalendarClock, CalendarPlus, LoaderCircle, Plus, RefreshCw } from "@lucide/vue"
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useRoute, useRouter } from "vue-router"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { scheduleSyncRevision } from "../../composables/useScheduledTasks.ts"
import { machineOrderGroup, useSidebarOrder } from "../../composables/useSidebarOrder.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import UiButton from "../common/UiButton.vue"
import UiScrollArea from "../common/UiScrollArea.vue"
import { describeTrigger } from "../schedules/schedule-format.ts"
import SidebarMachineGroup, { type SidebarMachineHeaderItem } from "./SidebarMachineGroup.vue"

interface MachineScheduleState {
  tasks: ScheduledTask[]
  loaded: boolean
  loading: boolean
  error?: string
}

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const account = useAccountSession()
const fleet = useFleetStore()
const sidebarOrder = useSidebarOrder()

const states = reactive<Record<string, MachineScheduleState>>({})
const collapsed = reactive(new Set<string>())
const refreshing = ref(false)
const revisions = new Map<string, number>()
let disposed = false

const machines = computed<SidebarMachineHeaderItem[]>(() => {
  if (account) {
    const teamId = account.teamId.value
    return sidebarOrder.ordered(
      machineOrderGroup,
      account.machines.value.filter(m => m.teamId === teamId),
    ).map(m => ({
      id: m.id,
      name: m.name,
      local: m.id === account.localMachineId.value,
      online: m.online,
      lastSeen: m.lastSeenAt ?? undefined,
    }))
  }
  return sidebarOrder.ordered(machineOrderGroup, fleet.machines).map(m => ({
    id: m.id,
    name: m.name,
    local: m.local,
    online: m.online,
    lastSeen: m.lastSeen,
  }))
})

const selectedScheduleId = computed(() =>
  route.name === "schedules" && typeof route.params.scheduleId === "string" ? route.params.scheduleId : undefined,
)
const creating = computed(() => selectedScheduleId.value === "new")
const createTargetMachineId = computed(() => {
  if (!account) return undefined
  const current = machines.value.find(m => m.id === account.machineId.value)
  if (current?.online) return current.id
  return machines.value.find(m => m.online)?.id
})

function stateOf(machineId: string): MachineScheduleState {
  if (!states[machineId]) states[machineId] = { tasks: [], loaded: false, loading: false }
  return states[machineId]!
}

function isOpen(machine: SidebarMachineHeaderItem): boolean {
  return !collapsed.has(machine.id)
}

function setOpen(machine: SidebarMachineHeaderItem, open: boolean): void {
  if (open) {
    collapsed.delete(machine.id)
    if (!stateOf(machine.id).loaded) void loadMachine(machine, true)
  } else {
    collapsed.add(machine.id)
  }
}

async function loadMachine(machine: SidebarMachineHeaderItem, background = false): Promise<void> {
  const teamId = account?.teamId.value
  if (!account || !teamId) return
  const state = stateOf(machine.id)
  const revision = (revisions.get(machine.id) ?? 0) + 1
  revisions.set(machine.id, revision)
  state.loading = true
  try {
    const central = withCentralRequestTrigger(account.central, background ? "background" : "user")
    const tasks = machine.online
      ? await schedulesClient(central, teamId, machine.id).list()
      : (await central.scheduleSnapshot(teamId, machine.id)).tasks
    if (disposed || revisions.get(machine.id) !== revision) return
    state.tasks = tasks
    state.loaded = true
    state.error = undefined
  } catch (reason) {
    if (!disposed && revisions.get(machine.id) === revision) {
      state.error = reason instanceof Error ? reason.message : String(reason)
    }
  } finally {
    if (!disposed && revisions.get(machine.id) === revision) state.loading = false
  }
}

async function refreshAll(background = false): Promise<void> {
  if (!account) return
  refreshing.value = true
  try {
    await Promise.all(machines.value.filter(isOpen).map(machine => loadMachine(machine, background)))
  } finally {
    if (!disposed) refreshing.value = false
  }
}

function isActiveTask(machineId: string, taskId: string): boolean {
  return selectedScheduleId.value === taskId && (!account || account.machineId.value === machineId)
}

function openTask(machineId: string, scheduleId: string): void {
  const destination = { name: "schedules", params: { scheduleId } }
  if (account) account.openMachineRoute(machineId, destination)
  else void router.push(destination)
}

watch(
  () => [account?.teamId.value ?? "", machines.value.map(m => `${m.id}:${m.online}`).join(",")] as const,
  ([teamId], previous) => {
    if (previous && previous[0] !== teamId) {
      for (const key of Object.keys(states)) delete states[key]
      collapsed.clear()
      revisions.clear()
    }
    if (!teamId) return
    for (const machine of machines.value) {
      if (!machine.online && !stateOf(machine.id).loaded) collapsed.add(machine.id)
      if (isOpen(machine)) void loadMachine(machine, true)
    }
  },
  { immediate: true },
)

watch(scheduleSyncRevision, () => {
  void refreshAll(true)
})

const unsubscribe = account?.central.onEvent(event => {
  if (event.type !== "catalogChanged" || event.teamId !== account.teamId.value) return
  const machine = machines.value.find(m => m.id === event.machineId)
  if (machine && isOpen(machine)) void loadMachine(machine, true)
})

onBeforeUnmount(() => {
  disposed = true
  unsubscribe?.()
})
</script>

<template>
  <div role="tabpanel" aria-labelledby="sidebar-tab-schedules" data-sidebar-panel="schedules" class="flex min-h-0 flex-1 flex-col">
    <div v-if="createTargetMachineId" class="app-no-drag shrink-0 px-2 pb-2">
      <button
        type="button"
        data-sidebar-schedule-new-primary
        class="ui-nav-item w-full px-2.5 text-left"
        :class="creating && 'ui-nav-active'"
        :aria-current="creating ? 'page' : undefined"
        @click="openTask(createTargetMachineId, 'new')"
      >
        <CalendarPlus :size="16" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
        <span class="truncate">{{ t("schedules.create") }}</span>
      </button>
    </div>

    <UiScrollArea class="min-h-0 min-w-0 flex-1" content-class="px-2 pt-1 pb-3">
      <div class="mb-1 flex items-center justify-between gap-2 pl-2.5 pr-1 text-xs text-ui-text-faint">
        <span>{{ t("schedules.title") }}</span>
        <div class="flex shrink-0 items-center gap-0.5">
          <UiButton
            v-if="account"
            variant="ghost"
            size="icon"
            class="!h-6 !w-6 rounded-md text-ui-text-faint [&:not(:disabled,[aria-disabled=true])]:hover:bg-ui-text/8 [&:not(:disabled,[aria-disabled=true])]:hover:text-ui-text"
            :label="t('catalog.refresh')"
            :disabled="refreshing"
            @click="refreshAll(false)"
          >
            <RefreshCw :size="14" :stroke-width="1.75" :class="refreshing && 'animate-spin'" aria-hidden="true" />
          </UiButton>
        </div>
      </div>

      <p v-if="!account" role="status" class="mx-2.5 rounded-lg border border-ui-border bg-ui-surface px-2.5 py-2 text-xs text-ui-text-muted">
        {{ t("schedules.signIn") }}
      </p>

      <div v-else>
        <SidebarMachineGroup
          v-for="machine in machines"
          :key="machine.id"
          :machine="machine"
          :open="isOpen(machine)"
          :reorder-items="machines"
          @update:open="setOpen(machine, $event)"
        >
          <template v-if="machine.online" #actions>
            <UiButton
              variant="ghost"
              size="icon"
              class="!h-6 !w-6 rounded-md text-current [&:not(:disabled,[aria-disabled=true])]:hover:bg-ui-text/8 [&:not(:disabled,[aria-disabled=true])]:hover:text-ui-text"
              :label="t('schedules.create')"
              data-sidebar-schedule-new
              @click="openTask(machine.id, 'new')"
            >
              <Plus :size="14" :stroke-width="1.75" aria-hidden="true" />
            </UiButton>
          </template>

          <li v-if="stateOf(machine.id).error" class="pl-4 pr-2.5 py-1 text-xs text-ui-danger" role="alert">
            {{ stateOf(machine.id).error }}
          </li>
          <li v-else-if="stateOf(machine.id).loading && !stateOf(machine.id).loaded" class="flex items-center gap-2 pl-4 pr-2.5 py-1.5 text-xs text-ui-text-faint">
            <LoaderCircle :size="13" class="animate-spin shrink-0" aria-hidden="true" />
            <span>{{ t("schedules.loading") }}</span>
          </li>
          <template v-else-if="stateOf(machine.id).tasks.length">
            <li v-for="task in stateOf(machine.id).tasks" :key="task.id">
              <button
                type="button"
                :data-schedule-id="task.id"
                class="ui-nav-item h-auto min-h-9 w-full flex-col items-start gap-0.5 pl-4 pr-2.5 py-1.5 text-left"
                :class="isActiveTask(machine.id, task.id) && 'ui-nav-active'"
                :aria-current="isActiveTask(machine.id, task.id) ? 'page' : undefined"
                @click="openTask(machine.id, task.id)"
              >
                <span class="flex w-full min-w-0 items-center gap-2">
                  <span
                    class="h-1.5 w-1.5 shrink-0 rounded-full"
                    :class="task.enabled || task.trigger.kind === 'manual' ? 'bg-ui-success' : 'bg-ui-text-faint/50'"
                    aria-hidden="true"
                  />
                  <span class="min-w-0 flex-1 truncate text-[13px]">{{ task.title }}</span>
                </span>
                <span class="w-full truncate pl-3.5 text-[11px] text-ui-text-faint">
                  {{ describeTrigger(task.trigger, t, locale) }}
                </span>
              </button>
            </li>
          </template>
          <li v-else-if="stateOf(machine.id).loaded" class="flex items-center gap-2 pl-4 pr-2.5 py-1.5 text-xs text-ui-text-faint">
            <CalendarClock :size="13" class="shrink-0 opacity-60" aria-hidden="true" />
            <span class="truncate">{{ t("schedules.empty") }}</span>
          </li>
        </SidebarMachineGroup>
      </div>
    </UiScrollArea>
  </div>
</template>
