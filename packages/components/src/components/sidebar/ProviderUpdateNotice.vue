<script setup lang="ts">
import type { ProviderUpdate } from "@deskfleet/client/providers"
import { Check, Download } from "@lucide/vue"
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { AGENT_PROVIDER_TEMPLATES, type AgentProviderTemplateId } from "../../../../../apps/daemon/src/provider-protocol.ts"
import { useProviderUpdateMachines, type MachineProviderUpdates } from "../../composables/useProviderUpdateMachines.ts"
import ConfirmDialog from "../common/ConfirmDialog.vue"
import ProviderIcon from "../common/ProviderIcon.vue"
import UiButton from "../common/UiButton.vue"
import UiCheckbox from "../common/UiCheckbox.vue"

const COMPLETED_HOLD_MS = 1_500

type RowStatus = ProviderUpdate["status"] | "completed"

interface MachineRow {
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
  status: RowStatus
  rows: MachineRow[]
}

interface Completion {
  machineId: string
  template: AgentProviderTemplateId
  latestVersion: string
}

const machines = useProviderUpdateMachines()
const { t } = useI18n()

const confirmingKey = ref<string | null>(null)
const selected = ref(new Set<string>())
/** Machine and template pairs held briefly after a finished update leaves the snapshot. */
const completed = shallowRef<Completion[]>([])
const holdTimers = new Set<ReturnType<typeof setTimeout>>()
onScopeDispose(() => holdTimers.forEach(clearTimeout))

const updateKey = (machineId: string, template: string) => `${machineId}\n${template}`
const updatesByKey = computed(() => new Map(machines.value.flatMap(machine =>
  Object.entries(machine.updates).flatMap(([template, update]) => update
    ? [[updateKey(machine.id, template), { machine, template: template as AgentProviderTemplateId, update }] as const]
    : []))))

watch(updatesByKey, (current, previous) => {
  for (const [key, { machine, template, update }] of previous) {
    if (update.status !== "updating" || current.has(key)) continue
    const completion = { machineId: machine.id, template, latestVersion: update.latestVersion }
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
  const byKey = new Map<string, Omit<UpdateGroup, "status">>()
  function add(template: AgentProviderTemplateId, latestVersion: string, row: MachineRow): void {
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
    add(template, update.latestVersion, { machine, currentVersion: update.currentVersion, status: update.status, error: update.error })
  }
  for (const completion of completed.value) {
    const machine = machines.value.find(value => value.id === completion.machineId)
    if (!machine || updatesByKey.value.has(updateKey(completion.machineId, completion.template))) continue
    add(completion.template, completion.latestVersion, { machine, currentVersion: completion.latestVersion, status: "completed" })
  }
  // An update only on offline machines cannot be acted on yet.
  return [...byKey.values()]
    .filter(group => group.rows.some(row => row.machine.online || row.status === "completed"))
    .map(group => ({ ...group, status: resolveGroupStatus(group.rows) }))
})

const selectable = (row: MachineRow) => row.machine.online && (row.status === "available" || row.status === "error")

const BUTTON_LABELS: Record<RowStatus, string> = {
  available: "providerUpdates.install",
  updating: "providerUpdates.updating",
  error: "providerUpdates.retry",
  completed: "providerUpdates.updated",
}
const BUTTON_ARIA_LABELS: Record<RowStatus, string> = {
  available: "providerUpdates.installAria",
  updating: "providerUpdates.updatingAria",
  error: "providerUpdates.retryAria",
  completed: "providerUpdates.updatedAria",
}

function cardText(group: UpdateGroup): string {
  if (group.status === "completed") return t("providerUpdates.completed", { name: group.name, version: group.latestVersion })
  const count = group.rows.filter(row => row.status !== "completed").length
  return t("providerUpdates.available", { name: group.name, version: group.latestVersion, count }, count)
}

function rowText(row: MachineRow): string {
  if (!row.machine.online) return t("providerUpdates.offline")
  if (row.status === "updating") return t("providerUpdates.updating")
  if (row.status === "completed") return t("providerUpdates.updated")
  return t("providerUpdates.current", { version: row.currentVersion })
}

const confirming = computed(() => groups.value.find(group => group.key === confirmingKey.value))
const chosenRows = computed(() => confirming.value?.rows.filter(row => selectable(row) && selected.value.has(row.machine.id)) ?? [])

function openConfirm(group: UpdateGroup): void {
  selected.value = new Set(group.rows.filter(selectable).map(row => row.machine.id))
  confirmingKey.value = group.key
}

function toggle(machineId: string, checked: boolean): void {
  const next = new Set(selected.value)
  if (checked) next.add(machineId)
  else next.delete(machineId)
  selected.value = next
}

function focusCancel(event: Event): void {
  event.preventDefault()
  if (event.target instanceof HTMLElement) event.target.querySelector<HTMLElement>("[data-confirm-cancel]")?.focus()
}

async function upgradeChosen(): Promise<void> {
  const template = confirming.value!.template
  const rows = chosenRows.value
  const results = await Promise.allSettled(rows.map(row => row.machine.upgrade(template)))
  const failures = rows.flatMap((row, index) => {
    const result = results[index]!
    if (result.status === "fulfilled") return []
    const error = result.reason instanceof Error ? result.reason.message : String(result.reason)
    return [t("providerUpdates.machineFailed", { machine: row.machine.name, error })]
  })
  // Machines that accepted the update now show it; the dialog stays open on the failed ones.
  if (failures.length > 0) throw new Error(failures.join("\n"))
}
</script>

<template>
  <div v-if="groups.length" data-provider-updates class="app-no-drag flex shrink-0 flex-col gap-2 px-2 pb-2">
    <div
      v-for="group in groups"
      :key="group.key"
      :data-provider-update="group.template"
      class="rounded-lg border border-ui-accent/25 bg-ui-accent/8 p-2"
    >
      <div class="mb-2 flex items-center gap-1.5 px-0.5 text-xs text-ui-text-muted">
        <ProviderIcon :template="group.template" :size="14" class="shrink-0" />
        <p class="m-0 min-w-0 truncate">{{ cardText(group) }}</p>
      </div>
      <UiButton
        variant="primary"
        class="w-full"
        :loading="group.status === 'updating'"
        :disabled="group.status === 'completed'"
        :aria-label="t(BUTTON_ARIA_LABELS[group.status], { name: group.name })"
        data-provider-update-action
        @click="openConfirm(group)"
      >
        <Check v-if="group.status === 'completed'" :size="14" class="shrink-0" aria-hidden="true" />
        <Download v-else-if="group.status !== 'updating'" :size="14" class="shrink-0" aria-hidden="true" />
        <span class="min-w-0 truncate">{{ t(BUTTON_LABELS[group.status]) }}</span>
      </UiButton>
      <template v-for="row in group.rows" :key="row.machine.id">
        <p
          v-if="row.machine.online && row.status === 'error'"
          role="alert"
          :title="row.error"
          class="m-0 mt-2 break-words px-0.5 text-xs text-ui-danger"
        >
          {{ t("providerUpdates.machineFailed", { machine: row.machine.name, error: row.error }) }}
        </p>
      </template>
    </div>
  </div>

  <ConfirmDialog
    v-if="confirming"
    data-provider-update-dialog
    tone="primary"
    :title="t('providerUpdates.confirmTitle', { name: confirming.name, version: confirming.latestVersion })"
    :description="t('providerUpdates.confirmDescription', { name: confirming.name })"
    :confirm-label="t('providerUpdates.confirmAction', { count: chosenRows.length }, chosenRows.length)"
    :confirm-disabled="chosenRows.length === 0"
    :confirm="upgradeChosen"
    @open-auto-focus="focusCancel"
    @close="confirmingKey = null"
  >
    <ul class="m-0 mt-4 flex list-none flex-col gap-1 p-0" data-provider-update-machines>
      <li v-for="row in confirming.rows" :key="row.machine.id" class="flex flex-col gap-0.5 rounded-md px-1 py-1.5">
        <label class="flex items-center gap-2 text-sm" :class="selectable(row) ? 'cursor-pointer' : 'text-ui-text-muted'">
          <UiCheckbox
            :model-value="selectable(row) && selected.has(row.machine.id)"
            :disabled="!selectable(row)"
            :aria-label="t('providerUpdates.selectMachine', { name: confirming.name, machine: row.machine.name })"
            @update:model-value="toggle(row.machine.id, $event)"
          />
          <span class="min-w-0 flex-1 truncate">{{ row.machine.name }}</span>
          <span class="shrink-0 text-xs text-ui-text-muted">{{ rowText(row) }}</span>
        </label>
        <p v-if="row.machine.online && row.status === 'error'" class="m-0 break-words pl-6 text-xs text-ui-danger">{{ row.error }}</p>
      </li>
    </ul>
  </ConfirmDialog>
</template>
