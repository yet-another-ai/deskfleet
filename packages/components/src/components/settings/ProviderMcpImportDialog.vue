<script setup lang="ts">
import { Import, LoaderCircle } from "@lucide/vue"
import { useAsyncState, watchImmediate } from "@vueuse/core"
import { DialogDescription, DialogTitle } from "reka-ui"
import { computed, onBeforeUnmount, ref, toRaw, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { mcpServersClient } from "@deskfleet/client/mcp-servers"
import type { AgentProviderConfig, ProviderMcpServerDiscovery } from "../../../../../apps/daemon/src/provider-protocol.ts"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import UiButton from "../common/UiButton.vue"
import UiCheckbox from "../common/UiCheckbox.vue"
import UiDialog from "../common/UiDialog.vue"
import UiScrollArea from "../common/UiScrollArea.vue"
import UiSelect from "../common/UiSelect.vue"

const props = defineProps<{ provider?: AgentProviderConfig; machineName: string }>()
const emit = defineEmits<{ close: []; imported: []; busy: [value: boolean] }>()
const dialog = useTemplateRef<InstanceType<typeof UiDialog>>("dialog")
const { t } = useI18n()
const client = usePlatformClient()
const account = useAccountSession()
const fleet = useFleetStore()
const teamId = account?.teamId.value
const machineId = fleet.targetId
const api = account && teamId ? mcpServersClient(account.central, teamId, machineId) : undefined
const online = computed(() => !!api && account?.teamId.value === teamId && fleet.targetId === machineId
  && !!account?.machines.value.find(machine => machine.id === machineId)?.online)
const providerId = ref("")
type Candidate = ProviderMcpServerDiscovery["candidates"][number]
type ImportRow = Candidate & { importName: string; selected: boolean; status: "available" | "importing" | "imported"; error?: string }
const rows = ref<ImportRow[]>([])
const discovery = ref<ProviderMcpServerDiscovery>()
const loading = ref(false)
const discoveryError = ref<string>()
const existingNames = ref(new Set<string>())
const importing = ref(false)
const importError = ref<string>()
const selected = computed(() => rows.value.filter(row => row.selected && row.server && row.status === "available"))
const imported = computed(() => rows.value.filter(row => row.status === "imported").length)
const canImport = computed(() => selected.value.length > 0 && selected.value.every(row => !nameProblem(row)))
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
const nameKey = (name: string) => name.trim().toLowerCase()
let disposed = false
let revision = 0
onBeforeUnmount(() => { disposed = true; revision++; emit("busy", false) })

const { state: providers, isLoading: providersLoading, error: providersError, executeImmediate: loadProviders } = useAsyncState(async () => {
  if (!online.value) return []
  const values = props.provider ? [props.provider] : (await client.providers.list()).providers
    .filter(provider => provider.template === "codex" || provider.template === "claude-code")
  if (!disposed) providerId.value = values[0]?.id ?? ""
  return values
}, [])

function nameProblem(row: ImportRow): string | undefined {
  const key = nameKey(row.importName)
  if (!key || row.importName.trim().length > 128 || row.importName.includes("\0")) return t("mcpServers.import.nameRequired")
  if (["deskfleet", "auv"].includes(key)) return t("mcpServers.import.reservedName")
  if (existingNames.value.has(key)) return t("mcpServers.import.existingName")
  if (rows.value.some(other => other.id !== row.id && other.selected && other.status === "available" && nameKey(other.importName) === key)) return t("mcpServers.import.duplicateName")
  return undefined
}

async function discover(): Promise<void> {
  const request = ++revision
  if (!online.value || !api || !providerId.value) return
  loading.value = true
  discoveryError.value = undefined
  try {
    const [result, snapshot] = await Promise.all([client.providers.discoverMcpServers(providerId.value), api.list()])
    if (disposed || request !== revision) return
    existingNames.value = new Set(snapshot.servers.map(server => nameKey(server.name)))
    discovery.value = result
    rows.value = result.candidates.map(candidate => ({ ...candidate, importName: candidate.name, selected: false, status: "available" }))
  } catch (reason) { if (!disposed && request === revision) discoveryError.value = message(reason) }
  finally { if (!disposed && request === revision) loading.value = false }
}
watchImmediate(providerId, () => {
  revision++
  rows.value = []
  discovery.value = undefined
  discoveryError.value = undefined
  importError.value = undefined
  loading.value = false
  if (providerId.value && online.value) void discover()
})
watch(online, connected => {
  // Preserve reviewed names and confirmed imports. Even a brief disconnect ends
  // the current batch; reconnecting must not resume its remaining writes.
  revision++
  loading.value = false
  if (connected && providerId.value && !discovery.value) void discover()
}, { flush: "sync" })
watch([() => account?.teamId.value, () => account?.machineId.value], ([team, machine]) => {
  if (team !== teamId || (machine && machine !== machineId)) {
    disposed = true
    revision++
    dialog.value?.close()
  }
}, { flush: "sync" })
watch(importing, value => emit("busy", value), { flush: "sync" })

async function importSelected(): Promise<void> {
  if (importing.value || loading.value || !online.value || !api || !canImport.value) return
  importing.value = true
  importError.value = undefined
  const pending = [...selected.value]
  const batchRevision = revision
  try {
    const snapshot = await api.list()
    if (disposed || !online.value || batchRevision !== revision) return
    existingNames.value = new Set(snapshot.servers.map(server => nameKey(server.name)))
    for (const row of pending) {
      if (disposed || !online.value || batchRevision !== revision) break
      row.error = undefined
      const problem = nameProblem(row)
      if (problem) { row.selected = false; row.error = problem; continue }
      row.status = "importing"
      try {
        const created = await api.create({ ...toRaw(row.server!), name: row.importName.trim() })
        row.status = "imported"
        row.selected = false
        existingNames.value.add(nameKey(created.name))
        if (!disposed) emit("imported")
      } catch (reason) {
        row.status = "available"
        row.error = message(reason)
      }
    }
  } catch (reason) { if (!disposed) importError.value = message(reason) }
  finally { importing.value = false }
}

function close(): void { if (!importing.value) dialog.value?.close() }
</script>

<template>
  <UiDialog ref="dialog" class="flex w-[min(42rem,calc(100vw-2rem))] flex-col" described :prevent-close="importing" data-provider-mcp-import @close="emit('close')">
    <div class="mb-4 flex items-start gap-3">
      <Import :size="22" :stroke-width="1.5" class="mt-0.5 shrink-0 text-ui-text-muted" aria-hidden="true" />
      <div class="min-w-0">
        <DialogTitle class="ui-dialog-title">{{ t("mcpServers.import.title") }}</DialogTitle>
        <DialogDescription class="ui-dialog-description">{{ t("mcpServers.import.description", { machine: machineName }) }}</DialogDescription>
      </div>
    </div>
    <p class="m-0 mb-4 text-xs leading-5 text-ui-text-muted">{{ t("mcpServers.import.scopeHint") }}</p>
    <p v-if="!online" role="status" class="m-0 mb-4 text-sm text-ui-text-muted">{{ t("mcpServers.offline") }}</p>
    <label v-if="!provider && providers.length" class="mb-4 flex flex-col gap-1.5 text-sm">{{ t("mcpServers.import.provider") }}
      <UiSelect v-model="providerId" :aria-label="t('mcpServers.import.provider')" :disabled="!online || importing" :options="providers.map(value => ({ value: value.id, label: value.name }))" />
    </label>
    <p v-else-if="provider" class="m-0 mb-4 text-sm font-medium">{{ provider.name }}</p>
    <p v-if="providersLoading || loading" role="status" class="m-0 flex items-center gap-2 py-6 text-sm text-ui-text-muted"><LoaderCircle :size="16" class="animate-spin" aria-hidden="true" />{{ t("mcpServers.import.loading") }}</p>
    <div v-else-if="providersError || discoveryError" class="flex items-center justify-between gap-3">
      <p role="alert" class="m-0 text-sm text-ui-danger">{{ message(providersError || discoveryError) }}</p>
      <UiButton type="button" :disabled="!online" @click="providersError ? loadProviders() : discover()">{{ t("folderPicker.retry") }}</UiButton>
    </div>
    <p v-else-if="!providers.length" role="status" class="m-0 py-5 text-sm text-ui-text-muted">{{ t("mcpServers.import.noProviders") }}</p>
    <template v-else-if="discovery">
      <p v-for="warning in discovery.warnings" :key="warning" role="status" class="m-0 mb-3 text-sm text-ui-text-muted">{{ warning }}</p>
      <p v-if="!rows.length" role="status" class="m-0 py-5 text-sm text-ui-text-muted">{{ t(discovery.supported ? "mcpServers.import.empty" : "mcpServers.import.unsupported") }}</p>
      <UiScrollArea v-else class="max-h-[min(28rem,50dvh)] min-h-0 rounded-xl border border-ui-border" fade-size="sm">
        <div v-for="row in rows" :key="row.id" class="flex items-start gap-3 border-b border-ui-border p-3 last:border-b-0" :data-mcp-import-candidate="row.id">
          <UiCheckbox v-model="row.selected" :disabled="!online || importing || !row.server || row.status !== 'available' || (!!nameProblem(row) && !row.selected)" :aria-label="t('mcpServers.import.select', { name: row.importName })" class="mt-2" />
          <div class="min-w-0 flex-1">
            <input v-if="row.server" v-model="row.importName" :aria-label="t('mcpServers.import.name', { name: row.name })" class="ui-input w-full text-sm" maxlength="128" autocomplete="off" :disabled="!online || importing || row.status !== 'available'" @input="row.error = undefined" />
            <span v-else class="block text-sm font-medium">{{ row.name }}</span>
            <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-ui-text-muted">
              <span class="ui-badge">{{ t(`mcpServers.import.${row.scope}Scope`) }}</span>
              <span v-if="row.server">{{ row.server.transport === 'http' ? 'Streamable HTTP' : row.server.transport }}</span>
              <span v-if="row.server && !row.server.enabled">{{ t("mcpServers.import.disabledServer") }}</span>
            </div>
            <p v-if="row.projectPath" class="m-0 mt-1 break-all font-mono text-xs text-ui-text-muted">{{ row.projectPath }}</p>
            <p class="m-0 mt-1 break-all text-xs text-ui-text-faint">{{ t("mcpServers.import.source", { source: row.source }) }}</p>
            <p v-if="row.unsupportedReason" role="status" class="m-0 mt-2 text-xs text-ui-text-muted">{{ row.unsupportedReason }}</p>
            <p v-else-if="row.status !== 'available'" role="status" class="m-0 mt-2 text-xs text-ui-text-muted">{{ t(`mcpServers.import.${row.status}`) }}</p>
            <p v-else-if="nameProblem(row)" role="status" class="m-0 mt-2 text-xs text-ui-text-muted">{{ nameProblem(row) }}</p>
            <p v-if="row.error" role="alert" class="m-0 mt-2 text-xs text-ui-danger">{{ row.error }}</p>
          </div>
        </div>
      </UiScrollArea>
      <p v-if="imported" role="status" class="m-0 mt-3 text-sm text-ui-text-muted">{{ t("mcpServers.import.importedCount", imported) }}</p>
    </template>
    <p v-if="importError" role="alert" class="m-0 mt-3 text-sm text-ui-danger">{{ importError }}</p>
    <div class="ui-dialog-actions flex-wrap">
      <UiButton type="button" :disabled="importing" data-mcp-import-close @click="close">{{ t(imported ? "providers.workspaceImport.done" : "catalog.cancel") }}</UiButton>
      <UiButton v-if="rows.length" variant="primary" type="button" :disabled="!online || loading || importing || !canImport" data-mcp-import-selected @click="importSelected">{{ importing ? t("mcpServers.import.importing") : t("mcpServers.import.importSelected", selected.length) }}</UiButton>
    </div>
  </UiDialog>
</template>
