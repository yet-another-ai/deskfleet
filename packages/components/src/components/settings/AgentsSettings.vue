<script setup lang="ts">
import { client as platformClient } from "@deskfleet/client/platform"

import { Bot, Ellipsis, Pencil, Plus, Trash2 } from "@lucide/vue"
import { onClickOutside } from "@vueuse/core"
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentProviderConfig, AgentProviderInput, ProviderSnapshot, ProviderTestResult } from "../../../../../apps/daemon/src/provider-protocol.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import IconButton from "../common/IconButton.vue"
import ProviderIcon from "../common/ProviderIcon.vue"
import ProviderDialog from "./ProviderDialog.vue"

const { t } = useI18n()
const fleet = useFleetStore()
const selectedMachineId = ref(fleet.machines.find(machine => machine.local)?.id ?? fleet.machines[0]?.id)
const machine = computed(() => fleet.machines.find(value => value.id === selectedMachineId.value))
const available = computed(() => machine.value?.id === fleet.targetId && machine.value.online)
const snapshot = ref<ProviderSnapshot | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const editor = ref<{ initial?: AgentProviderConfig } | null>(null)
const openMenu = ref<string | null>(null)
const list = useTemplateRef<HTMLElement>("list")
const removeDialog = useTemplateRef<HTMLDialogElement>("removeDialog")
const removing = ref<AgentProviderConfig | null>(null)
const removePending = ref(false)
const removeError = ref<string | null>(null)
let revision = 0
onClickOutside(list, () => { openMenu.value = null })

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
watch(() => [machine.value?.id, available.value], () => { editor.value = null; openMenu.value = null; void refresh() }, { immediate: true })
const unsubscribe = platformClient.providers.onChanged(() => { void refresh() })
onBeforeUnmount(() => { revision++; unsubscribe() })
const templateName = (provider: AgentProviderConfig) => snapshot.value?.templates.find(template => template.id === provider.template)?.name ?? provider.template
const binary = (provider: AgentProviderConfig) => provider.binaryPath || snapshot.value?.templates.find(template => template.id === provider.template)?.defaultBinaryPath

function edit(provider: AgentProviderConfig): void {
  openMenu.value = null
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
async function askRemove(provider: AgentProviderConfig): Promise<void> {
  openMenu.value = null
  removing.value = provider
  removeError.value = null
  await nextTick()
  removeDialog.value?.showModal()
}
function cancelRemove(): void {
  if (removePending.value) return
  removing.value = null
  removeDialog.value?.close()
}
async function remove(): Promise<void> {
  if (!removing.value || removePending.value) return
  removePending.value = true
  removeError.value = null
  try {
    await platformClient.providers.remove(removing.value.id)
    removeDialog.value?.close()
    removing.value = null
    await refresh()
  } catch (reason) { removeError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { removePending.value = false }
}
</script>

<template>
  <div class="mb-6 flex items-center justify-between gap-4">
    <h1 class="m-0 text-lg font-semibold">{{ t("settings.agents") }}</h1>
    <button type="button" class="catalog-button inline-flex items-center gap-1.5" :disabled="!available || !snapshot || loading" @click="editor = {}">
      <Plus :size="16" :stroke-width="1.75" aria-hidden="true" />{{ t("providers.add") }}
    </button>
  </div>
  <nav :aria-label="t('providers.machines')" class="mb-5 flex gap-5 overflow-x-auto border-b border-ui-border">
    <button v-for="item in fleet.machines" :key="item.id" type="button" class="relative flex shrink-0 cursor-pointer items-center gap-2 border-b-2 px-0 pb-3 text-sm" :class="item.id === selectedMachineId ? 'border-ui-text text-ui-text' : 'border-transparent text-ui-text-muted hover:text-ui-text'" :aria-current="item.id === selectedMachineId ? 'page' : undefined" @click="selectedMachineId = item.id">
      <span class="h-1.5 w-1.5 rounded-full" :class="item.online ? 'bg-ui-success' : 'bg-ui-text-muted'" aria-hidden="true" />
      {{ item.name }}
      <span v-if="!item.online" class="sr-only">{{ t("machine.offline") }}</span>
    </button>
  </nav>
  <p v-if="!available" role="status" class="m-0 py-6 text-sm text-ui-text-muted">{{ t(machine?.id === fleet.targetId ? "providers.offline" : "providers.remoteUnavailable") }}</p>
  <div v-else>
    <div v-if="error" class="mb-4 flex items-center justify-between gap-4">
      <p role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <button type="button" class="catalog-button shrink-0" :disabled="loading" @click="refresh">{{ t("folderPicker.retry") }}</button>
    </div>
    <p v-if="loading && !snapshot" role="status" class="m-0 py-6 text-sm text-ui-text-muted">{{ t("providers.loading") }}</p>
    <template v-if="snapshot">
      <div v-if="snapshot.providers.length" ref="list" class="rounded-xl border border-ui-border bg-ui-surface shadow-ui-card" @keydown.esc.stop="openMenu = null">
        <div v-for="(provider, index) in snapshot.providers" :key="provider.id" class="flex items-center gap-4 px-5 py-4" :class="index > 0 && 'border-t border-ui-border'" :data-provider-id="provider.id">
          <ProviderIcon :icon="provider.icon" :template="provider.template" :size="22" class="text-ui-text-muted" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-medium">{{ provider.name }}</div>
            <div class="mt-1 flex min-w-0 items-center gap-1.5 text-[13px] text-ui-text-muted">
              <span class="shrink-0">{{ templateName(provider) }}</span><span aria-hidden="true">·</span>
              <span class="truncate" :title="binary(provider)">{{ binary(provider) }}</span><span aria-hidden="true">·</span>
              <span class="shrink-0">{{ t("providers.environmentCount", Object.keys(provider.env).length) }}</span>
            </div>
          </div>
          <div class="relative shrink-0">
            <IconButton :icon="Ellipsis" :label="t('providers.actions', { name: provider.name })" :aria-expanded="openMenu === provider.id" aria-haspopup="menu" @click="openMenu = openMenu === provider.id ? null : provider.id" />
            <div v-if="openMenu === provider.id" role="menu" class="absolute top-full right-0 z-20 mt-1 flex w-40 flex-col rounded-lg border border-ui-border bg-ui-surface p-1 shadow-ui-card">
              <button type="button" role="menuitem" class="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-ui-hover" @click="edit(provider)"><Pencil :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t("providers.edit") }}</button>
              <button type="button" role="menuitem" class="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] text-ui-danger hover:bg-ui-hover" @click="askRemove(provider)"><Trash2 :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t("providers.remove") }}</button>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="flex flex-col items-center gap-2 rounded-xl border border-dashed border-ui-border px-6 py-12 text-center">
        <Bot :size="28" :stroke-width="1.5" class="mb-1 text-ui-text-muted" aria-hidden="true" />
        <p class="m-0 text-sm font-medium">{{ t("providers.empty") }}</p>
        <p class="m-0 max-w-sm text-[13px] text-ui-text-muted">{{ t("providers.emptyDescription") }}</p>
      </div>
    </template>
  </div>
  <ProviderDialog v-if="editor && snapshot" :initial="editor.initial" :templates="snapshot.templates" :disabled="!available" :save="save" :test="test" @saved="editor = null" @cancel="editor = null" />
  <dialog ref="removeDialog" class="ui-dialog app-no-drag w-[26rem]" aria-labelledby="provider-remove-title" @cancel.prevent="cancelRemove" @close="cancelRemove">
    <h2 id="provider-remove-title" class="m-0 mb-2 text-base font-semibold">{{ t("providers.removeQuestion", { name: removing?.name ?? '' }) }}</h2>
    <p class="m-0 mb-4 text-sm text-ui-text-muted">{{ t("providers.removeDescription") }}</p>
    <p v-if="removeError" role="alert" class="m-0 mb-4 text-sm text-ui-danger">{{ removeError }}</p>
    <div class="flex justify-end gap-2">
      <button type="button" class="catalog-button" :disabled="removePending" @click="cancelRemove">{{ t("catalog.cancel") }}</button>
      <button type="button" class="catalog-button text-ui-danger" :disabled="removePending || !available" @click="remove">{{ t("providers.remove") }}</button>
    </div>
  </dialog>
</template>
