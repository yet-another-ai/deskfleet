<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import { Pencil, Plug, Plus, Trash2 } from "@lucide/vue"
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { mcpServersClient, type McpServerConfig, type McpServerInput } from "@deskfleet/client/mcp-servers"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import ConfirmDialog from "../common/ConfirmDialog.vue"
import McpServerDialog from "./McpServerDialog.vue"

const { t } = useI18n()
const account = useAccountSession()
const fleet = useFleetStore()
const api = account && mcpServersClient(account.central, fleet.targetId)
const online = computed(() => !!api && (account?.machine.value?.online ?? fleet.localDesktopTarget.online))
const servers = ref<McpServerConfig[]>([])
const loaded = ref(false)
const loading = ref(false)
const pending = ref(false)
const error = ref<string>()
const editor = ref<{ initial?: McpServerConfig }>()
const removing = ref<McpServerConfig>()
let revision = 0
let disposed = false
async function refresh(): Promise<void> {
  const request = ++revision
  if (!online.value || !api) { loading.value = false; return }
  loading.value = true
  try {
    const snapshot = await api.list()
    if (disposed || request !== revision) return
    servers.value = snapshot.servers
    loaded.value = true
    error.value = undefined
  } catch (reason) { if (!disposed && request === revision) error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { if (!disposed && request === revision) loading.value = false }
}
async function mutate<T>(work: () => Promise<T>): Promise<T> {
  if (!online.value || !api) throw new Error(t("mcpServers.offline"))
  if (pending.value) throw new Error(t("mcpServers.busy"))
  ++revision
  loading.value = false
  pending.value = true
  error.value = undefined
  try { return await work() }
  finally { if (!disposed) pending.value = false }
}
function replace(server: McpServerConfig): void {
  const index = servers.value.findIndex(value => value.id === server.id)
  if (index < 0) servers.value.push(server)
  else servers.value[index] = server
}
async function save(input: McpServerInput): Promise<void> {
  const initial = editor.value?.initial
  await mutate(async () => {
    const server = initial ? await api!.update(initial.id, input) : await api!.create(input)
    if (!disposed) replace(server)
  })
}
async function toggle(server: McpServerConfig): Promise<void> {
  const { id, ...input } = server
  try { await mutate(async () => {
    const updated = await api!.update(id, { ...input, enabled: !server.enabled })
    if (!disposed) replace(updated)
  }) } catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason) }
}
async function remove(): Promise<void> {
  const server = removing.value
  if (!server) return
  await mutate(async () => {
    await api!.remove(server.id)
    if (!disposed) servers.value = servers.value.filter(value => value.id !== server.id)
  })
}
watch(online, () => { void refresh() }, { immediate: true })
const focus = () => { if (!pending.value && !editor.value && !removing.value) void refresh() }
window.addEventListener("focus", focus)
onBeforeUnmount(() => { disposed = true; revision++; window.removeEventListener("focus", focus) })
</script>

<template>
  <div class="mb-6 flex flex-wrap items-center justify-between gap-4">
    <h1 class="ui-page-title">{{ t('mcpServers.title') }}</h1>
    <UiButton type="button" data-mcp-add  :disabled="!online || !loaded || pending" @click="editor = {}"><Plus :size="16" aria-hidden="true" />{{ t('mcpServers.add') }}</UiButton>
  </div>
  <p class="m-0 mb-5 text-sm leading-6 text-ui-text-muted">{{ t('mcpServers.description', { machine: account?.machine.value?.name ?? fleet.machines[0]?.name }) }}</p>
  <p v-if="!online" role="status" class="m-0 mb-4 text-sm text-ui-text-muted">{{ t(api ? 'mcpServers.offline' : 'schedules.signIn') }}</p>
  <div v-if="error" class="mb-4 flex items-center justify-between gap-3"><p role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p><UiButton type="button" :disabled="!online || loading || pending" @click="refresh">{{ t('folderPicker.retry') }}</UiButton></div>
  <p v-if="loading && !loaded" role="status" class="m-0 py-5 text-sm text-ui-text-muted">{{ t('mcpServers.loading') }}</p>
  <template v-if="loaded">
    <div class="ui-section-header"><h2 class="ui-section-title">{{ t('mcpServers.servers') }}</h2><UiButton variant="ghost" size="sm" type="button" class="cursor-pointer hover:bg-ui-hover disabled:op-50" :disabled="!online || loading || pending" @click="refresh">{{ t('catalog.refresh') }}</UiButton></div>
    <div v-if="!servers.length" class="ui-empty"><Plug :size="25" class="mb-2 text-ui-text-muted" aria-hidden="true" /><p class="m-0 text-sm text-ui-text-muted">{{ t('mcpServers.empty') }}</p></div>
    <ul v-else class="ui-card">
      <li v-for="server in servers" :key="server.id" :data-mcp-server="server.id" class="flex flex-wrap items-center gap-3 px-4 py-3">
        <Plug :size="18" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
        <div class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">{{ server.name }}</span><span class="text-xs text-ui-text-muted">{{ server.transport === 'http' ? 'Streamable HTTP' : server.transport }}</span></div>
        <UiButton variant="ghost" size="sm" type="button" data-mcp-toggle class="cursor-pointer hover:bg-ui-hover disabled:op-50" :aria-label="t(server.enabled ? 'mcpServers.disableNamed' : 'mcpServers.enableNamed', { name: server.name })" :disabled="!online || pending" @click="toggle(server)">{{ t(server.enabled ? 'mcpServers.enabled' : 'mcpServers.disabled') }}</UiButton>
        <UiButton type="button" data-mcp-edit class="px-2" :aria-label="t('mcpServers.editNamed', { name: server.name })" :disabled="!online || pending" @click="editor = { initial: server }"><Pencil :size="14" aria-hidden="true" /></UiButton>
        <UiButton type="button" data-mcp-remove class="px-2" :aria-label="t('mcpServers.removeNamed', { name: server.name })" :disabled="!online || pending" @click="removing = server"><Trash2 :size="14" aria-hidden="true" /></UiButton>
      </li>
    </ul>
    <p class="m-0 mt-4 text-xs leading-5 text-ui-text-muted">{{ t('mcpServers.appliesNext') }}</p>
  </template>
  <McpServerDialog v-if="editor" :initial="editor.initial" :disabled="!online" :save="save" @close="editor = undefined" />
  <ConfirmDialog v-if="removing" :title="t('mcpServers.removeTitle', { name: removing.name })" :description="t('mcpServers.removeHint')" :confirm-label="t('mcpServers.remove')" :confirm="remove" @close="removing = undefined" />
</template>
