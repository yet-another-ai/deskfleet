<script setup lang="ts">
import { Cloud, Cpu, LoaderCircle } from "@lucide/vue"
import { computed, ref, useId, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { CentralApi, Machine } from "@deskfleet/client/central"
import type { SuperAgentConfig, SuperAgentMode } from "@deskfleet/client/super-agent"
import ErrorNotice from "../common/ErrorNotice.vue"
import UiButton from "../common/UiButton.vue"
import UiField from "../common/UiField.vue"
import UiSelect from "../common/UiSelect.vue"

interface ProviderOption { id: string; name: string }
interface WorkspaceOption { id: string; name: string }

const NO_WORKSPACE = "__none__"

const props = defineProps<{
  teamId: string
  config: SuperAgentConfig
  machines: readonly Machine[]
  localMachineId?: string
  api: Pick<CentralApi, "catalog" | "rpc" | "updateSuperAgentConfig">
  showCancel?: boolean
  portalTo?: HTMLElement
}>()
const emit = defineEmits<{ saved: [config: SuperAgentConfig]; cancel: [] }>()
const { t } = useI18n()
const id = useId()

const mode = ref<SuperAgentMode>(props.config.mode)
const machineId = ref(props.config.byoa?.machineId ?? props.localMachineId ?? props.machines.find(m => m.online)?.id ?? props.machines[0]?.id ?? "")
const providerId = ref(props.config.byoa?.providerId ?? "")
const workspaceId = ref(props.config.byoa?.workspaceId ?? NO_WORKSPACE)
const cwd = ref(props.config.byoa?.cwd ?? "")
const providers = ref<ProviderOption[]>([])
const workspaces = ref<WorkspaceOption[]>([])
const loadingMachine = ref(false)
const machineLoadError = ref<unknown>()
const saving = ref(false)
const saved = ref(false)
const saveError = ref<unknown>()

let discoveryRevision = 0

function syncFromConfig(next: SuperAgentConfig): void {
  mode.value = next.mode
  if (next.byoa) {
    machineId.value = next.byoa.machineId
    providerId.value = next.byoa.providerId
    workspaceId.value = next.byoa.workspaceId ?? NO_WORKSPACE
    cwd.value = next.byoa.cwd ?? ""
  } else if (!machineId.value) {
    machineId.value = props.localMachineId ?? props.machines.find(m => m.online)?.id ?? props.machines[0]?.id ?? ""
  }
}

watch(() => props.config, next => {
  syncFromConfig(next)
  saved.value = false
})

async function loadMachineOptions(targetMachineId: string): Promise<void> {
  const revision = ++discoveryRevision
  if (!targetMachineId) {
    providers.value = []
    workspaces.value = []
    loadingMachine.value = false
    machineLoadError.value = undefined
    return
  }
  loadingMachine.value = true
  machineLoadError.value = undefined
  try {
    const machine = props.machines.find(item => item.id === targetMachineId)
    const [catalogResult, liveProvidersResult] = await Promise.allSettled([
      props.api.catalog(props.teamId, targetMachineId),
      machine?.online ? props.api.rpc<{ providers?: ProviderOption[] }>(props.teamId, targetMachineId, "providerList", {}) : Promise.resolve(undefined),
    ])
    if (revision !== discoveryRevision) return
    const catalog = catalogResult.status === "fulfilled" ? catalogResult.value : undefined
    const live = liveProvidersResult.status === "fulfilled" ? liveProvidersResult.value : undefined
    const list = live?.providers?.length ? live.providers : (catalog?.providers?.providers ?? [])
    providers.value = list.map(item => ({ id: item.id, name: item.name }))
    workspaces.value = (catalog?.snapshot.workspaces ?? []).map(item => ({ id: item.id, name: item.name }))
    if (catalogResult.status === "rejected" && liveProvidersResult.status === "rejected") {
      machineLoadError.value = catalogResult.reason
    }
    if (providers.value.length && !providers.value.some(item => item.id === providerId.value)) {
      providerId.value = providers.value[0]!.id
    }
    if (workspaceId.value !== NO_WORKSPACE && !workspaces.value.some(item => item.id === workspaceId.value)) {
      workspaceId.value = NO_WORKSPACE
    }
  } finally {
    if (revision === discoveryRevision) loadingMachine.value = false
  }
}

watch([() => mode.value, () => machineId.value, () => props.teamId], ([currentMode, currentMachine]) => {
  if (currentMode === "byoa" && currentMachine) void loadMachineOptions(currentMachine)
}, { immediate: true })

const readonly = computed(() => !props.config.canConfigure)
const machineOptions = computed(() => props.machines.map(machine => {
  const base = machine.id === props.localMachineId ? t("superAgent.thisComputer", { name: machine.name }) : machine.name
  return { value: machine.id, label: machine.online ? base : t("superAgent.machineOfflineOption", { name: base }) }
}))
const providerOptions = computed(() => {
  const list = [...providers.value]
  if (providerId.value && !list.some(item => item.id === providerId.value)) {
    list.unshift({
      id: providerId.value,
      name: props.config.byoa?.providerId === providerId.value && props.config.byoa.providerName
        ? props.config.byoa.providerName
        : providerId.value,
    })
  }
  return list.map(item => ({ value: item.id, label: item.name }))
})
const workspaceOptions = computed(() => [
  { value: NO_WORKSPACE, label: t("superAgent.workspaceNone") },
  ...workspaces.value.map(item => ({ value: item.id, label: item.name })),
])

const selectedWorkspaceId = computed(() => workspaceId.value === NO_WORKSPACE ? null : workspaceId.value)
const trimmedCwd = computed(() => cwd.value.trim() || null)

const changed = computed(() => {
  if (mode.value !== props.config.mode) return true
  if (mode.value === "hosted") return false
  const current = props.config.byoa
  return !current
    || current.machineId !== machineId.value
    || current.providerId !== providerId.value
    || (current.workspaceId ?? null) !== selectedWorkspaceId.value
    || (current.cwd ?? null) !== trimmedCwd.value
})
const valid = computed(() => mode.value === "hosted" || (!!machineId.value && !!providerId.value))

async function submit(): Promise<void> {
  if (readonly.value || saving.value || !valid.value || !changed.value) return
  saving.value = true
  saveError.value = undefined
  saved.value = false
  try {
    const selectedProvider = providerOptions.value.find(item => item.value === providerId.value)
    const selectedWorkspace = workspaces.value.find(item => item.id === selectedWorkspaceId.value)
    const updated = await props.api.updateSuperAgentConfig(props.teamId, mode.value === "byoa"
      ? {
        mode: "byoa",
        byoa: {
          machineId: machineId.value,
          providerId: providerId.value,
          providerName: selectedProvider?.label ?? null,
          workspaceId: selectedWorkspaceId.value,
          workspaceName: selectedWorkspace?.name ?? null,
          cwd: trimmedCwd.value,
        },
      }
      : { mode: "hosted" })
    saved.value = true
    emit("saved", updated)
  } catch (error) {
    saveError.value = error
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <form class="flex flex-col gap-4" @submit.prevent="submit">
    <div class="grid gap-2.5 sm:grid-cols-2" role="radiogroup" :aria-label="t('superAgent.modeLabel')">
      <button
        type="button"
        role="radio"
        :aria-checked="mode === 'hosted'"
        :disabled="readonly || saving"
        data-super-agent-mode="hosted"
        class="flex cursor-pointer flex-col items-start gap-1.5 rounded-xl border p-3.5 text-left ui-motion disabled:cursor-default disabled:op-60"
        :class="mode === 'hosted' ? 'border-ui-accent bg-ui-accent/6' : 'border-ui-border bg-ui-surface hover:bg-ui-hover'"
        @click="mode = 'hosted'; saved = false"
      >
        <span class="flex items-center gap-2 text-sm font-medium">
          <Cloud :size="16" :class="mode === 'hosted' ? 'text-ui-accent' : 'text-ui-text-muted'" aria-hidden="true" />
          {{ t("superAgent.modeCloud") }}
        </span>
        <span class="text-xs leading-4.5 text-ui-text-muted">{{ t("superAgent.modeCloudDescription") }}</span>
        <span v-if="!config.hostedConfigured" class="text-xs text-ui-warning">{{ t("superAgent.modeCloudUnavailable") }}</span>
      </button>
      <button
        type="button"
        role="radio"
        :aria-checked="mode === 'byoa'"
        :disabled="readonly || saving"
        data-super-agent-mode="byoa"
        class="flex cursor-pointer flex-col items-start gap-1.5 rounded-xl border p-3.5 text-left ui-motion disabled:cursor-default disabled:op-60"
        :class="mode === 'byoa' ? 'border-ui-accent bg-ui-accent/6' : 'border-ui-border bg-ui-surface hover:bg-ui-hover'"
        @click="mode = 'byoa'; saved = false"
      >
        <span class="flex items-center gap-2 text-sm font-medium">
          <Cpu :size="16" :class="mode === 'byoa' ? 'text-ui-accent' : 'text-ui-text-muted'" aria-hidden="true" />
          {{ t("superAgent.modeByoa") }}
        </span>
        <span class="text-xs leading-4.5 text-ui-text-muted">{{ t("superAgent.modeByoaDescription") }}</span>
      </button>
    </div>

    <div v-if="mode === 'byoa'" class="ui-card flex flex-col gap-3.5 p-4" data-super-agent-byoa-fields>
      <p v-if="!machines.length" class="m-0 text-sm text-ui-text-muted">{{ t("superAgent.noMachines") }}</p>
      <template v-else>
        <div class="flex flex-col gap-1.5">
          <label :for="`${id}-machine`" class="text-[13px] font-medium">{{ t("superAgent.selectMachine") }}</label>
          <UiSelect
            :id="`${id}-machine`"
            v-model="machineId"
            name="super-agent-machine"
            :options="machineOptions"
            :placeholder="t('superAgent.selectMachinePlaceholder')"
            :disabled="readonly || saving"
            :portal-to="portalTo"
          />
        </div>

        <p v-if="loadingMachine" role="status" class="m-0 flex items-center gap-2 text-xs text-ui-text-muted">
          <LoaderCircle :size="14" class="animate-spin" aria-hidden="true" />{{ t("superAgent.loadingMachineOptions") }}
        </p>
        <ErrorNotice v-if="machineLoadError" :error="machineLoadError" />

        <div class="flex flex-col gap-1.5">
          <label :for="`${id}-provider`" class="text-[13px] font-medium">{{ t("superAgent.selectProvider") }}</label>
          <UiSelect
            v-if="providerOptions.length"
            :id="`${id}-provider`"
            v-model="providerId"
            name="super-agent-provider"
            :options="providerOptions"
            :placeholder="t('superAgent.selectProviderPlaceholder')"
            :disabled="readonly || saving || loadingMachine"
            :portal-to="portalTo"
          />
          <p v-else-if="!loadingMachine" class="m-0 text-xs text-ui-text-muted">{{ t("superAgent.noProviders") }}</p>
        </div>

        <div class="flex flex-col gap-1.5">
          <label :for="`${id}-workspace`" class="text-[13px] font-medium">{{ t("superAgent.selectWorkspace") }}</label>
          <UiSelect
            :id="`${id}-workspace`"
            v-model="workspaceId"
            name="super-agent-workspace"
            :options="workspaceOptions"
            :disabled="readonly || saving || loadingMachine"
            :portal-to="portalTo"
          />
          <p class="m-0 text-xs text-ui-text-muted">{{ t("superAgent.workspaceHint") }}</p>
        </div>

        <UiField
          v-model="cwd"
          :label="t('superAgent.cwdLabel')"
          :placeholder="t('superAgent.cwdPlaceholder')"
          name="super-agent-cwd"
          :disabled="readonly || saving"
          autocomplete="off"
          spellcheck="false"
        />
      </template>
    </div>

    <p v-if="readonly" class="m-0 text-xs text-ui-text-muted">{{ t("superAgent.configReadOnly") }}</p>
    <ErrorNotice v-if="saveError" :error="saveError" />
    <p v-else-if="saved && !changed" role="status" class="m-0 text-xs text-ui-text-muted">{{ t("superAgent.configSaved") }}</p>

    <div class="flex flex-wrap items-center justify-end gap-2">
      <UiButton v-if="showCancel" type="button" :disabled="saving" @click="emit('cancel')">{{ t("catalog.cancel") }}</UiButton>
      <UiButton v-if="!readonly" type="submit" variant="primary" data-super-agent-config-save :disabled="saving || !valid || !changed">
        {{ t(saving ? "catalog.saving" : "catalog.save") }}
      </UiButton>
    </div>
  </form>
</template>
