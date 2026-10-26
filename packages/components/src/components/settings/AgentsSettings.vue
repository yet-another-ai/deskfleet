<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import { client as platformClient } from "@deskfleet/client/platform"

import { Bot, Ellipsis, Pencil, Plus, Trash2 } from "@lucide/vue"
import { watchImmediate } from "@vueuse/core"
import { DialogTitle, DialogDescription, DropdownMenuItem } from "reka-ui"
import { computed, onBeforeUnmount, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentProviderConfig, AgentProviderInput, ProviderSnapshot, ProviderTestResult } from "../../../../../apps/daemon/src/provider-protocol.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import ProviderIcon from "../common/ProviderIcon.vue"
import ProviderDialog from "./ProviderDialog.vue"
import MenuPopover from "../common/MenuPopover.vue"
import UiDialog from "../common/UiDialog.vue"

const { t } = useI18n()
const fleet = useFleetStore()
const selectedMachineId = ref(fleet.machines.find(machine => machine.local)?.id ?? fleet.machines[0]?.id)
const machine = computed(() => fleet.machines.find(value => value.id === selectedMachineId.value))
const available = computed(() => machine.value?.id === fleet.targetId && machine.value.online)
const snapshot = ref<ProviderSnapshot | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const editor = ref<{ initial?: AgentProviderConfig } | null>(null)
const removing = ref<AgentProviderConfig | null>(null)
const removePending = ref(false)
const removeError = ref<string | null>(null)
let revision = 0

async function refresh(): Promise<void> {
  const request = ++revision
  if (!available.value) { snapshot.value = null; error.value = null; loading.value = false; return }
  loading.value = true
  error.value = null
  try {
    const value = await platformClient.providers.list()
    if (request === revision) snapshot.value = value
  } catch (reason) {
    if (request === revision) error.value = reason instanceof Error ? reason.message : String(reason)
  } finally { if (request === revision) loading.value = false }
}
watchImmediate([() => machine.value?.id, available], () => { editor.value = null; void refresh() })
const unsubscribe = platformClient.providers.onChanged(() => { void refresh() })
onBeforeUnmount(() => { revision++; unsubscribe() })
const templateName = (provider: AgentProviderConfig) => snapshot.value?.templates.find(template => template.id === provider.template)?.name ?? provider.template

function edit(provider: AgentProviderConfig): void {
  editor.value = { initial: provider }
}
async function save(provider: AgentProviderInput): Promise<void> {
  const initial = editor.value?.initial
  if (initial) {
    const { name, binaryPath, env, icon } = provider
    await platformClient.providers.update(initial.id, { name, binaryPath, env, icon })
  } else await platformClient.providers.create(provider)
  await refresh()
}
function test(provider: AgentProviderInput): Promise<ProviderTestResult> {
  return platformClient.providers.test(provider)
}
function askRemove(provider: AgentProviderConfig): void {
  removing.value = provider
  removeError.value = null
}
function cancelRemove(): void {
  if (removePending.value) return
  removing.value = null
}
async function remove(): Promise<void> {
  if (!removing.value || removePending.value) return
  removePending.value = true
  removeError.value = null
  try {
    await platformClient.providers.remove(removing.value.id)
    removing.value = null
    await refresh()
  } catch (reason) { removeError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { removePending.value = false }
}
</script>

<template>
  <div class="mb-6 flex items-center justify-between gap-4">
    <h1 class="ui-page-title">{{ t("settings.agents") }}</h1>
    <UiButton type="button" :disabled="!available || !snapshot || loading" @click="editor = {}">
      <Plus :size="16" :stroke-width="1.75" aria-hidden="true" />{{ t("providers.add") }}
    </UiButton>
  </div>
  <nav :aria-label="t('providers.machines')" class="mb-5 flex gap-5 overflow-x-auto border-b border-ui-border">
    <button v-for="item in fleet.machines" :key="item.id" type="button" class="relative flex shrink-0 cursor-pointer items-center gap-2 border-b-2 px-0 pb-3 text-sm" :class="item.id === selectedMachineId ? 'border-ui-accent text-ui-text' : 'border-transparent text-ui-text-muted hover:text-ui-text'" :aria-current="item.id === selectedMachineId ? 'page' : undefined" @click="selectedMachineId = item.id">
      <span class="h-1.5 w-1.5 rounded-full" :class="item.online ? 'bg-ui-success' : 'bg-ui-text-muted'" aria-hidden="true" />
      {{ item.name }}
      <span v-if="!item.online" class="sr-only">{{ t("machine.offline") }}</span>
    </button>
  </nav>
  <p v-if="!available" role="status" class="m-0 py-6 text-sm text-ui-text-muted">{{ t(machine?.id === fleet.targetId ? "providers.offline" : "providers.remoteUnavailable") }}</p>
  <div v-else>
    <div v-if="error" class="mb-4 flex items-center justify-between gap-4">
      <p role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <UiButton type="button" class="shrink-0" :disabled="loading" @click="refresh">{{ t("folderPicker.retry") }}</UiButton>
    </div>
    <p v-if="loading && !snapshot" role="status" class="m-0 py-6 text-sm text-ui-text-muted">{{ t("providers.loading") }}</p>
    <template v-if="snapshot">
      <div v-if="snapshot.providers.length" class="rounded-xl border border-ui-border bg-ui-surface shadow-ui-card">
        <div v-for="(provider, index) in snapshot.providers" :key="provider.id" class="flex items-center gap-2 py-1.5 pr-3 pl-1.5" :class="index > 0 && 'border-t border-ui-border'" :data-provider-id="provider.id">
          <button type="button" class="flex min-w-0 flex-1 cursor-pointer items-center gap-3.5 rounded-lg px-3 py-2.5 text-left hover:bg-ui-hover" :aria-label="t('providers.editNamed', { name: provider.name })" data-provider-open @click="edit(provider)">
            <ProviderIcon :icon="provider.icon" :template="provider.template" :size="20" class="shrink-0" />
            <span class="min-w-0 truncate text-sm font-medium">{{ provider.name }}</span>
            <span v-if="templateName(provider) !== provider.name" class="ui-badge shrink-0" data-provider-row-template>{{ templateName(provider) }}</span>
          </button>
          <MenuPopover :label="t('providers.actions', { name: provider.name })">
            <template #trigger><Ellipsis :size="16" aria-hidden="true" /></template>
            <template #default="{ openDialog }">
              <DropdownMenuItem as="button" type="button" class="ui-menu-item" @select="openDialog(() => edit(provider))"><Pencil :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t("providers.edit") }}</DropdownMenuItem>
              <DropdownMenuItem as="button" type="button" class="ui-menu-item text-ui-danger" @select="openDialog(() => askRemove(provider))"><Trash2 :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t("providers.remove") }}</DropdownMenuItem>
            </template>
          </MenuPopover>
        </div>
      </div>
      <div v-else class="ui-empty gap-2 py-12">
        <Bot :size="28" :stroke-width="1.5" class="mb-1 text-ui-text-muted" aria-hidden="true" />
        <p class="m-0 text-sm font-medium">{{ t("providers.empty") }}</p>
        <p class="m-0 max-w-sm text-[13px] text-ui-text-muted">{{ t("providers.emptyDescription") }}</p>
      </div>
    </template>
  </div>
  <ProviderDialog v-if="editor && snapshot" :initial="editor.initial" :templates="snapshot.templates" :disabled="!available" :machine-name="machine?.name ?? ''" :save="save" :test="test" :probe="platformClient.providers.probe" :install="platformClient.providers.install" :login="platformClient.providers.login" @saved="editor = null" @cancel="editor = null" />
  <UiDialog v-if="removing" class="w-[26rem]" described :prevent-close="removePending" @close="cancelRemove">
    <DialogTitle class="ui-dialog-title">{{ t("providers.removeQuestion", { name: removing.name }) }}</DialogTitle>
    <DialogDescription class="ui-dialog-description">{{ t("providers.removeDescription") }}</DialogDescription>
    <p v-if="removeError" role="alert" class="m-0 mt-4 text-sm text-ui-danger">{{ removeError }}</p>
    <div class="ui-dialog-actions">
      <UiButton type="button" :disabled="removePending" @click="cancelRemove">{{ t("catalog.cancel") }}</UiButton>
      <UiButton variant="danger" type="button" :disabled="removePending || !available" @click="remove">{{ t("providers.remove") }}</UiButton>
    </div>
  </UiDialog>
</template>
