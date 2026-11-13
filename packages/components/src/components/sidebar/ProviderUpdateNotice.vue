<script setup lang="ts">
import type { ProviderUpdate } from "@deskfleet/client/providers"
import { Check, Download, LoaderCircle, X } from "@lucide/vue"
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { AGENT_PROVIDER_TEMPLATES, type AgentProviderTemplateId } from "../../../../../apps/daemon/src/provider-protocol.ts"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useProviderUpdateMachines, type MachineProviderUpdates } from "../../composables/useProviderUpdateMachines.ts"
import ConfirmDialog from "../common/ConfirmDialog.vue"
import ProviderIcon from "../common/ProviderIcon.vue"
import UiButton from "../common/UiButton.vue"
import UiCheckbox from "../common/UiCheckbox.vue"

const COMPLETED_HOLD_MS = 1_500

type RowStatus = ProviderUpdate["status"] | "completed"

interface MachineRow {
  key: string
  template: AgentProviderTemplateId
  latestVersion: string
  machine: MachineProviderUpdates
  currentVersion: string
  status: RowStatus
  error?: string
}

/** One CLI and target version across every machine that needs it. */
interface UpdateGroup {
  key: string
  template: AgentProviderTemplateId
  name: string
  latestVersion: string
  rows: MachineRow[]
}

interface Completion {
  machineId: string
  teamId: string
  template: AgentProviderTemplateId
  latestVersion: string
}

const machines = useProviderUpdateMachines()
const account = useAccountSession()
const { t } = useI18n()

const confirming = ref(false)
const selected = ref(new Set<string>())
/** Machine and template pairs held briefly after a finished update leaves the snapshot. */
const completed = shallowRef<Completion[]>([])
const holdTimers = new Set<ReturnType<typeof setTimeout>>()
onScopeDispose(() => holdTimers.forEach(clearTimeout))
watch(() => account?.teamId.value, () => {
  completed.value = []
  confirming.value = false
  selected.value = new Set()
  holdTimers.forEach(clearTimeout)
  holdTimers.clear()
}, { flush: "sync" })

const updateKey = (machineId: string, template: string) => `${machineId}\n${template}`
const updatesByKey = computed(() => new Map(machines.value.flatMap(machine =>
  Object.entries(machine.updates).flatMap(([template, update]) => update
    ? [[updateKey(machine.id, template), { machine, template: template as AgentProviderTemplateId, update }] as const]
    : []))))

watch(updatesByKey, (current, previous) => {
  for (const [key, { machine, template, update }] of previous) {
    if (update.status !== "updating" || current.has(key) || machine.teamId !== account?.teamId.value || !machines.value.some(value => value.id === machine.id && value.online)) continue
    const completion = { machineId: machine.id, teamId: machine.teamId, template, latestVersion: update.latestVersion }
    completed.value = [...completed.value, completion]
    const timer = setTimeout(() => {
      holdTimers.delete(timer)
      completed.value = completed.value.filter(value => value !== completion)
    }, COMPLETED_HOLD_MS)
    holdTimers.add(timer)
  }
})

function resolveGroupStatus(rows: MachineRow[]): RowStatus {
  if (rows.every(row => !row.machine.online || row.status === "completed")) return "completed"
  if (rows.some(row => row.machine.online && row.status === "updating")) return "updating"
  return rows.some(row => row.machine.online && row.status === "error") ? "error" : "available"
}

const groups = computed<UpdateGroup[]>(() => {
  const byKey = new Map<string, UpdateGroup>()
  function add(template: AgentProviderTemplateId, latestVersion: string, row: MachineRow): void {
    if (row.machine.dismissed[template] === latestVersion) return
    const key = `${template}@${latestVersion}`
    let group = byKey.get(key)
    if (!group) {
      const name = AGENT_PROVIDER_TEMPLATES.find(value => value.id === template)?.name ?? template
      group = { key, template, name, latestVersion, rows: [] }
      byKey.set(key, group)
    }
    group.rows.push(row)
  }
  for (const { machine, template, update } of updatesByKey.value.values()) {
    add(template, update.latestVersion, { key: `${updateKey(machine.id, template)}\n${update.latestVersion}`, template, latestVersion: update.latestVersion, machine, currentVersion: update.currentVersion, status: update.status, error: update.error })
  }
  for (const completion of completed.value) {
    const machine = machines.value.find(value => value.id === completion.machineId && value.teamId === completion.teamId)
    if (!machine || updatesByKey.value.has(updateKey(completion.machineId, completion.template))) continue
    add(completion.template, completion.latestVersion, { key: `${updateKey(machine.id, completion.template)}\n${completion.latestVersion}`, template: completion.template, latestVersion: completion.latestVersion, machine, currentVersion: completion.latestVersion, status: "completed" })
  }
  // An update only on offline machines cannot be acted on yet.
  return [...byKey.values()]
    .filter(group => group.rows.some(row => row.machine.online || row.status === "completed"))
})
watch(groups, value => { if (value.length === 0) confirming.value = false })

const selectable = (row: MachineRow) => row.machine.online && (row.status === "available" || row.status === "error")

const rows = computed(() => groups.value.flatMap(group => group.rows))
const status = computed(() => resolveGroupStatus(rows.value))
const toolCount = computed(() => new Set(groups.value.map(group => group.template)).size)
const failedCount = computed(() => rows.value.filter(row => row.machine.online && row.status === "error").length)

function rowText(row: MachineRow): string {
  if (!row.machine.online) return t("providerUpdates.offline")
  if (row.status === "updating") return t("providerUpdates.updating")
  if (row.status === "completed") return t("providerUpdates.updated")
  return t("providerUpdates.current", { version: row.currentVersion })
}

const chosenRows = computed(() => rows.value.filter(row => selectable(row) && selected.value.has(row.key)))

function openConfirm(): void {
  selected.value = new Set(rows.value.filter(selectable).map(row => row.key))
  confirming.value = true
}

function toggle(key: string, checked: boolean): void {
  const next = new Set(selected.value)
  if (checked) next.add(key)
  else next.delete(key)
  selected.value = next
}

function dismiss(): void {
  for (const row of rows.value) row.machine.dismiss(row.template, row.latestVersion)
  completed.value = []
  confirming.value = false
}

function focusCancel(event: Event): void {
  event.preventDefault()
  if (event.target instanceof HTMLElement) event.target.querySelector<HTMLElement>("[data-confirm-cancel]")?.focus()
}

async function upgradeChosen(): Promise<void> {
  const byMachine = new Map<string, MachineRow[]>()
  for (const row of chosenRows.value) {
    const machineRows = byMachine.get(row.machine.id) ?? []
    machineRows.push(row)
    byMachine.set(row.machine.id, machineRows)
  }
  // Catalog sequencing is per machine; accept its requests in order while other machines proceed independently.
  const results = await Promise.all([...byMachine.values()].map(async machineRows => {
    const failures: string[] = []
    for (const row of machineRows) {
      try {
        await row.machine.upgrade(row.template)
      } catch (reason) {
        const name = AGENT_PROVIDER_TEMPLATES.find(value => value.id === row.template)?.name ?? row.template
        const error = reason instanceof Error ? reason.message : String(reason)
        failures.push(t("providerUpdates.machineFailed", { name, machine: row.machine.name, error }))
      }
    }
    return failures
  }))
  const failures = results.flat()
  // Machines that accepted the update now show it; the dialog stays open on the failed ones.
  if (failures.length > 0) throw new Error(failures.join("\n"))
}
</script>

<template>
  <div v-if="groups.length" data-provider-updates class="app-no-drag flex shrink-0 flex-col gap-2 px-2 pb-2">
    <div data-provider-update class="rounded-lg border border-ui-accent/25 bg-ui-accent/8 p-2">
      <div class="mb-2 flex items-center gap-1.5 text-xs text-ui-text-muted">
        <Check v-if="status === 'completed'" :size="14" class="shrink-0" aria-hidden="true" />
        <LoaderCircle v-else-if="status === 'updating'" :size="14" class="shrink-0 animate-spin" aria-hidden="true" />
        <Download v-else :size="14" class="shrink-0" aria-hidden="true" />
        <p class="m-0 min-w-0 flex-1">{{ status === 'completed' ? t('providerUpdates.completed') : t('providerUpdates.available', { count: toolCount }, toolCount) }}</p>
        <UiButton variant="ghost" size="icon" :label="t('providerUpdates.dismiss')" data-provider-update-dismiss @click="dismiss">
          <X :size="14" aria-hidden="true" />
        </UiButton>
      </div>
      <UiButton
        variant="primary"
        class="w-full"
        :disabled="status === 'completed'"
        data-provider-update-action
        @click="openConfirm"
      >
        {{ t(status === 'completed' ? 'providerUpdates.updated' : 'providerUpdates.review') }}
      </UiButton>
      <p v-if="failedCount" role="alert" class="m-0 mt-2 px-0.5 text-xs text-ui-danger">{{ t('providerUpdates.failed', { count: failedCount }, failedCount) }}</p>
    </div>
  </div>

  <ConfirmDialog
    v-if="confirming && groups.length"
    data-provider-update-dialog
    tone="primary"
    :title="t('providerUpdates.confirmTitle')"
    :description="t('providerUpdates.confirmDescription')"
    :confirm-label="t('providerUpdates.confirmAction', { count: chosenRows.length }, chosenRows.length)"
    :confirm-disabled="chosenRows.length === 0"
    :confirm="upgradeChosen"
    @open-auto-focus="focusCancel"
    @close="confirming = false"
  >
    <section v-for="group in groups" :key="group.key" :data-provider-update-group="group.template" class="mt-4">
      <h3 class="m-0 mb-1 flex items-center gap-2 text-sm font-medium">
        <ProviderIcon :template="group.template" :size="16" class="shrink-0" />
        <span>{{ group.name }}</span>
        <span class="ml-auto text-xs text-ui-text-muted">{{ group.latestVersion }}</span>
      </h3>
      <ul class="m-0 flex list-none flex-col gap-1 p-0" data-provider-update-machines>
        <li v-for="row in group.rows" :key="row.key" class="flex flex-col gap-0.5 rounded-md px-1 py-1.5">
          <label class="flex items-center gap-2 text-sm" :class="selectable(row) ? 'cursor-pointer' : 'text-ui-text-muted'">
            <UiCheckbox
              :model-value="selectable(row) && selected.has(row.key)"
              :disabled="!selectable(row)"
              :aria-label="t('providerUpdates.selectMachine', { name: group.name, machine: row.machine.name })"
              @update:model-value="toggle(row.key, $event)"
            />
            <span class="min-w-0 flex-1 truncate">{{ row.machine.name }}</span>
            <span class="shrink-0 text-xs text-ui-text-muted">{{ rowText(row) }}</span>
          </label>
          <p v-if="row.machine.online && row.status === 'error'" class="m-0 break-words pl-6 text-xs text-ui-danger">{{ row.error }}</p>
        </li>
      </ul>
    </section>
  </ConfirmDialog>
</template>
