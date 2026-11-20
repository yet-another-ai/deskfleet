<script setup lang="ts">
import { Check, ChevronDown, ChevronRight } from "@lucide/vue"
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "reka-ui"
import { computed, nextTick, onScopeDispose, ref, shallowRef, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useRouter } from "vue-router"
import type { SuperModelSelection, SuperSettings, SuperSnapshot } from "../../../../../apps/daemon/src/super-agent-protocol.ts"
import type { AgentChoice, AgentConfiguration } from "../../../../client/src/agent-configuration.ts"
import { useAgentConfigurationCacheStore } from "../../stores/agent-configuration-cache.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useProvidersStore } from "../../stores/providers.ts"
import GeminiPeriodicTableDialog from "./GeminiPeriodicTableDialog.vue"
import BottomSheet from "../common/BottomSheet.vue"
import ConfirmDialog from "../common/ConfirmDialog.vue"
import ProviderIcon from "../common/ProviderIcon.vue"
import SpringSurface from "../common/SpringSurface.ts"
import UiScrollArea from "../common/UiScrollArea.vue"

type Role = "coordinator" | "executor"
type Field = "provider" | "model" | "effort" | "mode" | "approval"
interface Choice extends AgentChoice { disabledReason?: string }
interface Row { field: Field; label: string; value?: string; choices: Choice[]; disabled?: boolean; effective?: string }
const props = defineProps<{
  snapshot: SuperSnapshot
  workers: AgentChoice[]
  disabled?: boolean
  touch?: boolean
  saveError?: string
  save: (settings: Omit<SuperSettings, "workspaceId">) => Promise<boolean>
}>()
const open = defineModel<boolean>("open", { default: false })
const agents = useAgentSessionsStore()
const providers = useProvidersStore()
const sharedCatalogs = useAgentConfigurationCacheStore()
const router = useRouter()
const { t, te } = useI18n()
// A legacy host only accepts the two literal CLI IDs. Other registered instances require a newer host.
const coordinators = computed<Choice[]>(() => {
  const available = props.snapshot.coordinatorProviders
  return props.workers.map(provider => {
    const supported = available ? available.some(item => item.id === provider.id) : ["codex", "claude-code"].includes(provider.id)
    return supported ? provider : { ...provider, disabledReason: t(available ? "superAgent.executionOnly" : "superAgent.hostUpdateRequired") }
  })
})
const coordinator = computed(() => coordinators.value.find(item => !item.disabledReason && item.id === props.snapshot.coordinator))
const icon = computed(() => providers.providers.find(item => item.id === coordinator.value?.id))
const executor = computed(() => props.workers.find(item => item.id === props.snapshot.provider))
const unselected = computed(() => t("superAgent.noSelection"))
const active = ref<string>()
const menu = useTemplateRef<{ $el: HTMLElement }>("menu")
const configuration = shallowRef<AgentConfiguration>()
const loading = ref(false)
const error = ref("")
const savePending = ref(false)
let disposed = false
onScopeDispose(() => { disposed = true })
const epoch = ref(0)
const busy = computed(() => props.disabled || savePending.value)
const defaultChoice = computed(() => ({ id: "", name: t("superAgent.providerDefault") }))
const withDefault = (options: AgentChoice[] = []) => [defaultChoice.value, ...options]
const effortName = (id: string, name = id) => te("composer.efforts." + id) ? t("composer.efforts." + id) : name
watch(open, value => { if (!value) active.value = undefined })

const workspace = computed(() => props.snapshot.workspaceId ?? undefined)
const confirmAutoApprove = ref(false)
watch(workspace, () => { confirmAutoApprove.value = false }, { flush: "sync" })
const tableOpen = ref(false)
const antigravity = computed(() => providers.providers.find(item => item.id === executor.value?.id)?.template === "antigravity")
watch([workspace, () => executor.value?.id, antigravity], () => { tableOpen.value = false })
function showTable() {
  tableOpen.value = true
  open.value = false
}
const catalogProvider = computed(() => props.snapshot.workerSelection && executor.value?.id)
const directory = computed(() => sharedCatalogs.workspaceDirectory(workspace.value))
const reads = new Map<string, Promise<AgentConfiguration>>()
watch([workspace, catalogProvider, directory, () => providers.revision], ([id, provider, path, revision], [oldId, oldProvider, oldPath, oldRevision]) => {
  if (id === oldId && provider === oldProvider && (oldPath === undefined || path === oldPath)
    && (oldRevision === undefined || revision === oldRevision)) return
  reads.clear()
  epoch.value++
}, { flush: "sync" })

// All provider-specific controls share the same configuration probe.
const catalogEffort = computed(() => props.snapshot.workerAutoApprove !== undefined ? props.snapshot.workerSelection?.reasoningEffort : undefined)
function catalog(model?: string) {
  const target = { provider: props.snapshot.provider, workspaceId: workspace.value }
  const mode = props.snapshot.workerSelection?.mode
  const effort = model === props.snapshot.workerSelection?.model ? catalogEffort.value : undefined
  const choices = { ...(model && { model }), ...(mode && { mode }), ...(effort && { reasoningEffort: effort }) }
  const key = JSON.stringify([model, mode, effort])
  const cached = sharedCatalogs.read(target, undefined, choices)
  if (cached) return Promise.resolve(cached)
  const existing = reads.get(key)
  if (existing) return existing
  const request = agents.agentConfiguration({ ...target, ...choices, cache: true, includeMatrix: false })
  reads.set(key, request)
  void request.catch(() => { if (reads.get(key) === request) reads.delete(key) })
  return request
}
watch([() => open.value || tableOpen.value, catalogProvider, () => props.snapshot.workerSelection?.model, () => props.snapshot.workerSelection?.mode, catalogEffort, epoch], async ([isOpen, provider, model], _, onCleanup) => {
  let current = true
  onCleanup(() => { current = false })
  configuration.value = undefined
  error.value = ""
  loading.value = !!(isOpen && provider)
  if (!isOpen || !provider) return
  try {
    const result = await catalog(model)
    if (current && result.provider.id === provider) configuration.value = result
  } catch (cause) {
    if (current) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { if (current) loading.value = false }
})

function coordinatorEfforts(model?: string): string[] {
  const options = props.snapshot.coordinatorOptions
  return model ? options?.models.find(option => option.id === model)?.reasoningEfforts ?? [] : options?.defaultReasoningEfforts ?? []
}
const executionModelRow = computed<Row>(() => ({
  field: "model", label: t("composer.model"), value: props.snapshot.workerSelection?.model,
  choices: withDefault(configuration.value?.models?.options), disabled: !executor.value || !props.snapshot.workerSelection,
}))
const groups = computed<{ role: Role; rows: Row[] }[]>(() => {
  const snapshot = props.snapshot
  const front = snapshot.coordinatorOverrides ?? {}
  const effective = coordinator.value ? snapshot.coordinatorSelection : undefined
  const execution = executor.value ? snapshot.workerSelection : undefined
  const cap = coordinator.value && snapshot.coordinatorOptions
  return [
    { role: "coordinator", rows: [
      { field: "provider", label: t("superAgent.routingProvider"), value: coordinator.value?.id, choices: coordinators.value },
      { field: "model", label: t("composer.model"), value: cap ? front.model : effective?.model, choices: withDefault(cap?.models), effective: effective?.model, disabled: !cap },
      { field: "effort", label: t("composer.reasoningEffort"), value: cap ? front.reasoningEffort : effective?.reasoningEffort,
        effective: effective?.reasoningEffort, choices: withDefault(coordinatorEfforts(front.model).map(id => ({ id, name: effortName(id) }))), disabled: !cap },
    ] },
    { role: "executor", rows: [
      { field: "provider", label: t("superAgent.executionProvider"), value: executor.value?.id, choices: props.workers },
      executionModelRow.value,
      { field: "effort", label: t("composer.reasoningEffort"), value: execution?.reasoningEffort,
        choices: withDefault(configuration.value?.reasoningEfforts?.options.map(item => ({ ...item, name: effortName(item.id, item.name) }))), disabled: !execution },
      ...(snapshot.workerAutoApprove === undefined ? [] : [
        { field: "mode" as const, label: t("superAgent.workerMode"), value: execution?.mode, effective: configuration.value?.modes?.currentValue,
          choices: withDefault(configuration.value?.modes?.options), disabled: !execution || (!execution.mode && !configuration.value?.modes?.options.length) },
        { field: "approval" as const, label: t("superAgent.toolApproval"), value: snapshot.workerAutoApprove ? "auto" : "manual",
          choices: [{ id: "manual", name: t("superAgent.manualApproval") }, { id: "auto", name: t("superAgent.autoApproval") }] },
      ]),
    ] },
  ]
})
function label(row: Row): string {
  if (!row.value && row.field === "provider") return unselected.value
  if (!row.value && row.effective) {
    const name = row.choices.find(choice => choice.id === row.effective)?.name ?? (row.field === "effort" ? effortName(row.effective) : row.effective)
    return defaultChoice.value.name + " · " + name
  }
  if (!row.value) return defaultChoice.value.name
  return row.choices.find(choice => choice.id === row.value)?.name ?? (row.field === "effort" ? effortName(row.value) : row.value)
}
function toggle(id: string, value: boolean) {
  if (value) active.value = id
  else if (active.value === id) active.value = undefined
}
async function choose(role: Role, row: Row, value: string) {
  if (busy.value || row.disabled || !row.choices.some(choice => choice.id === value && !choice.disabledReason)) return
  const { snapshot } = props
  const provider = snapshot.provider
  const catalogEpoch = epoch.value
  const frontProvider = coordinator.value?.id
  const field = row.field
  const id = role + "-" + field
  const selected = value || undefined
  const previous = role === "coordinator" ? snapshot.coordinatorOverrides : snapshot.workerSelection
  if (row.value !== selected) {
    if (field === "approval" && value === "auto") {
      open.value = false
      confirmAutoApprove.value = true
      return
    }
    savePending.value = true
    try {
      if (field === "approval") {
        await props.save({ workerAutoApprove: false })
      } else if (field === "mode") {
        await props.save({ workerMode: { provider, mode: selected ?? null } })
      } else if (field === "provider") {
        await props.save(role === "coordinator" ? { coordinator: value } : { provider: value })
      } else {
        const selection: SuperModelSelection = { ...previous }
        if (field === "effort") selection.reasoningEffort = selected
        else {
          selection.model = selected
          // Keep an explicit effort only when the newly selected model can use it.
          if (selection.reasoningEffort) {
            const efforts = role === "coordinator" ? coordinatorEfforts(selected) : (await catalog(selected)).reasoningEfforts?.options.map(item => item.id) ?? []
            if (!efforts.includes(selection.reasoningEffort)) delete selection.reasoningEffort
          }
        }
        if (disposed) return
        if (role === "coordinator" && frontProvider && frontProvider === coordinator.value?.id) await props.save({ coordinatorSelection: { provider: frontProvider, ...selection } })
        else if (role === "executor" && catalogEpoch === epoch.value && provider === props.snapshot.provider && snapshot.workspaceId === props.snapshot.workspaceId) await props.save({ workerSelection: { provider, ...selection } })
      }
    } catch (cause) {
      if (!disposed && catalogEpoch === epoch.value) error.value = cause instanceof Error ? cause.message : String(cause)
      return
    } finally { savePending.value = false }
  }
  active.value = undefined
  await nextTick()
  const element = menu.value?.$el
  if (open.value && element instanceof HTMLElement) element.querySelector<HTMLButtonElement>('[data-project-model-row="' + id + '"]')?.focus()
}
async function enableAutoApprove() {
  if (!confirmAutoApprove.value || disposed) return
  if (!await props.save({ workerAutoApprove: true })) throw new Error(props.saveError || t("errors.retry"))
}
// Restore the confirmed value until the daemon acknowledges the selection.
function selectOnTouch(role: Role, row: Row, event: Event) {
  const select = event.currentTarget as HTMLSelectElement
  const value = select.value
  select.value = row.value ?? ""
  void choose(role, row, value)
}
</script>

<template>
  <DropdownMenuRoot :open="!touch && open" :modal="false" @update:open="open = $event">
    <component :is="touch ? 'button' : DropdownMenuTrigger" type="button" data-project-model-trigger v-bind="touch ? { 'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: () => open = true } : {}" :aria-label="t('superAgent.projectModels')" :title="t('superAgent.projectModels')" class="ui-text-button min-w-0 max-w-full cursor-pointer leading-5 hover:bg-ui-hover hover:text-ui-text">
      <ProviderIcon :template="icon?.template ?? coordinator?.id" :icon="icon?.icon" :size="15" />
      <span class="truncate">{{ t('superAgent.roleSummary', { coordinator: coordinator?.name ?? unselected, executor: executor?.name ?? unselected }) }}</span>
      <ChevronDown :size="13" class="shrink-0" aria-hidden="true" />
    </component>
    <DropdownMenuPortal v-if="!touch">
      <DropdownMenuContent ref="menu" :as="SpringSurface" data-project-model-menu :aria-label="t('superAgent.projectModels')" class="ui-menu z-50 flex max-h-[var(--reka-popper-available-height)] w-72 flex-col overflow-hidden p-0" side="top" align="start" :side-offset="8" :collision-padding="8" loop>
        <UiScrollArea :focusable="false" fade-size="sm" class="min-h-0 flex-auto" content-class="p-1">
          <template v-for="group in groups" :key="group.role">
            <DropdownMenuSeparator v-if="group.role === 'executor'" class="-mx-1 my-1 h-px bg-ui-border" />
            <DropdownMenuSub v-for="row in group.rows" :key="row.field" :open="active === group.role + '-' + row.field" @update:open="toggle(group.role + '-' + row.field, $event)">
              <DropdownMenuSubTrigger as="button" type="button" :data-project-model-row="group.role + '-' + row.field" :disabled="busy || row.disabled" :title="t(group.role === 'coordinator' ? 'superAgent.coordinatorScope' : 'superAgent.workerScope')" class="ui-menu-item gap-3 focus:outline-none" :class="active === group.role + '-' + row.field && 'bg-ui-hover'">
                <span class="shrink-0">{{ row.label }}</span>
                <span class="ml-auto truncate text-ui-text-muted">{{ label(row) }}</span>
                <ChevronRight :size="14" class="shrink-0 text-ui-text-faint" aria-hidden="true" />
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent :as="SpringSurface" :aria-label="row.label" :side-offset="4" :collision-padding="8" class="ui-menu z-50 flex max-h-[min(20rem,var(--reka-popper-available-height))] min-w-44 max-w-[min(20rem,calc(100vw-16px))] flex-col overflow-hidden p-0" loop>
                  <UiScrollArea :focusable="false" fade-size="sm" class="min-h-0 flex-auto" content-class="p-1">
                    <DropdownMenuItem v-if="antigravity && group.role === 'executor' && row.field === 'model'" as="button" type="button" class="ui-menu-item" data-project-periodic-table :disabled="busy || row.disabled" @select="showTable">{{ t("composer.geminiPeriodicTable.trigger") }}</DropdownMenuItem>
                    <DropdownMenuRadioGroup :model-value="row.value ?? ''">
                      <DropdownMenuRadioItem v-for="choice in row.choices" :key="choice.id" as="button" type="button" :value="choice.id" :data-project-model-choice="choice.id || 'default'" :disabled="busy || !!choice.disabledReason" class="ui-menu-item focus:outline-none" @select.prevent="choose(group.role, row, choice.id)">
                        <span class="min-w-0 flex-1 truncate text-left">{{ choice.name }}</span>
                        <span v-if="choice.disabledReason" class="shrink-0 text-xs text-ui-text-muted">{{ choice.disabledReason }}</span>
                        <Check v-if="(row.value ?? '') === choice.id" :size="15" class="shrink-0" aria-hidden="true" />
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                    <p v-if="group.role === 'coordinator' && row.field === 'provider' && !snapshot.coordinatorProviders && row.choices.some(choice => choice.disabledReason)" class="m-0 px-2.5 py-1.5 text-xs text-ui-text-muted">{{ t('superAgent.updateHostForProviders') }}</p>
                    <DropdownMenuItem v-if="row.field === 'provider' && !row.choices.some(choice => !choice.disabledReason)" as="button" type="button" class="ui-menu-item" @select="router.push({ name: 'settings-agents' })">{{ t('providers.manage') }}</DropdownMenuItem>
                    <template v-if="group.role === 'executor' && row.field !== 'provider' && row.field !== 'approval'">
                      <p v-if="loading" role="status" class="m-0 px-2.5 py-1.5 text-xs text-ui-text-muted">{{ t('composer.loadingConfiguration') }}</p>
                      <p v-if="error" role="alert" class="m-0 break-words px-2.5 py-1.5 text-xs text-ui-danger">{{ error }}</p>
                      <DropdownMenuItem v-if="error" as="button" type="button" class="ui-menu-item" @select.prevent="epoch++">{{ t('composer.reloadConfiguration') }}</DropdownMenuItem>
                    </template>
                  </UiScrollArea>
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          </template>
        </UiScrollArea>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
  <BottomSheet v-if="touch" :open="open" :title="t('superAgent.projectModels')" @close="open = false">
    <div data-project-model-menu class="flex flex-col gap-3 px-4 pb-4">
      <fieldset v-for="group in groups" :key="group.role" class="m-0 min-w-0 border-0 border-b border-solid border-ui-border px-0 pb-2 last:border-b-0">
        <legend class="sr-only">{{ group.rows[0]!.label }}</legend>
        <label v-for="row in group.rows" :key="row.field" class="relative flex min-h-11 items-center gap-3 border-b border-ui-border px-1 py-2 text-sm last:border-b-0">
          <span class="shrink-0">{{ row.label }}</span>
          <span aria-hidden="true" class="ml-auto min-w-0 truncate text-ui-text-muted">{{ label(row) }}</span>
          <ChevronDown :size="15" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
          <select :aria-label="row.label" :data-project-model-row="group.role + '-' + row.field" :disabled="busy || row.disabled || !row.choices.some(choice => !choice.disabledReason)" class="absolute inset-0 h-full w-full opacity-0" @change="selectOnTouch(group.role, row, $event)">
            <option v-if="!row.choices.some(choice => choice.id === (row.value ?? ''))" :value="row.value ?? ''" selected disabled>{{ label(row) }}</option>
            <option v-for="choice in row.choices" :key="choice.id" :value="choice.id" :selected="choice.id === (row.value ?? '')" :disabled="!!choice.disabledReason">{{ choice.name }}{{ choice.disabledReason ? ' · ' + choice.disabledReason : '' }}</option>
          </select>
        </label>
        <button v-if="antigravity && group.role === 'executor'" type="button" class="ui-text-button min-h-11 text-ui-accent" data-project-periodic-table :disabled="busy || executionModelRow.disabled" @click="showTable">{{ t("composer.geminiPeriodicTable.trigger") }}</button>
        <button v-if="!group.rows[0]!.choices.some(choice => !choice.disabledReason)" type="button" class="ui-text-button min-h-11 text-ui-accent" @click="open = false; router.push({ name: 'settings-agents' })">{{ t("providers.manage") }}</button>
      </fieldset>
      <p v-if="loading" role="status" class="m-0 text-sm text-ui-text-muted">{{ t("composer.loadingConfiguration") }}</p>
      <div v-if="error" role="alert" class="break-words text-sm text-ui-danger">
        {{ error }} <button type="button" class="ui-text-button min-h-11 text-ui-accent" @click="epoch++">{{ t("composer.reloadConfiguration") }}</button>
      </div>
      <p v-if="saveError" role="alert" class="m-0 break-words text-sm text-ui-danger">{{ saveError }}</p>
    </div>
  </BottomSheet>
  <ConfirmDialog v-if="confirmAutoApprove" :title="t('superAgent.confirmAutoApproval')" :description="t('superAgent.autoApprovalScope')"
    :confirm-label="t('superAgent.autoApproval')" :confirm="enableAutoApprove" @close="confirmAutoApprove = false" />
  <GeminiPeriodicTableDialog v-if="tableOpen && antigravity"
    :models="configuration?.models?.options ?? []" :current-model="executionModelRow.value ?? configuration?.models?.currentValue"
    :loading="loading" :error="error || saveError" :disabled="busy || loading || executionModelRow.disabled"
    @select="choose('executor', executionModelRow, $event)" @reload="epoch++" @close="tableOpen = false" />
</template>
