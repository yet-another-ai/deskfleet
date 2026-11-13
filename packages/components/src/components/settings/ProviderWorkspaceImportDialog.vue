<script setup lang="ts">
import { FolderInput, LoaderCircle } from "@lucide/vue"
import { useAsyncState } from "@vueuse/core"
import { DialogDescription, DialogTitle } from "reka-ui"
import { computed, onBeforeUnmount, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentProviderConfig, ProviderWorkspaceDiscovery } from "../../../../../apps/daemon/src/provider-protocol.ts"
import type { CatalogSnapshot } from "../../../../client/src/catalog.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import UiButton from "../common/UiButton.vue"
import UiCheckbox from "../common/UiCheckbox.vue"
import UiDialog from "../common/UiDialog.vue"
import UiScrollArea from "../common/UiScrollArea.vue"

const props = defineProps<{ provider: AgentProviderConfig; machineName: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const client = usePlatformClient()
type Candidate = ProviderWorkspaceDiscovery["candidates"][number]
type ImportRow = Candidate & { selected: boolean; status: "available" | "existing" | "importing" | "imported"; error?: string }
const rows = ref<ImportRow[]>([])
const importing = ref(false)
const importError = ref<string>()
const selected = computed(() => rows.value.filter(row => row.selected && row.status === "available"))
const imported = computed(() => rows.value.filter(row => row.status === "imported").length)
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
let disposed = false
onBeforeUnmount(() => { disposed = true })

function pathKey(path: string): string {
  // The target machine can run a different OS from this client.
  const windows = /^(?:[a-z]:[/\\]|\\\\|\/\/)/iu.test(path)
  return (windows ? path.replaceAll("\\", "/").toLowerCase() : path).replace(/\/+$/u, "")
}

function workspacePaths(catalog: CatalogSnapshot): Set<string> {
  return new Set(catalog.workspaces.flatMap(workspace => workspace.worktrees
    .filter(worktree => !worktree.sessionId).flatMap(worktree => worktree.directories.map(directory => pathKey(directory.path)))))
}

const { state: discovery, isLoading: loading, error: discoveryError, executeImmediate: discover } = useAsyncState(async () => {
  const [result, catalog] = await Promise.all([client.providers.discoverWorkspaces(props.provider.id), client.catalog.list({ live: true })])
  if (disposed) return result
  const existing = workspacePaths(catalog)
  rows.value = result.candidates.map(candidate => ({ ...candidate, selected: false, status: existing.has(pathKey(candidate.path)) ? "existing" : "available" }))
  return result
}, null)

async function importSelected(): Promise<void> {
  if (importing.value || loading.value || !selected.value.length) return
  importing.value = true
  importError.value = undefined
  const pending = [...selected.value]
  try {
    // Recheck after the user has reviewed the list and before retrying partial imports.
    const existing = workspacePaths(await client.catalog.list({ live: true }))
    for (const row of pending) {
      if (disposed) break
      row.error = undefined
      if (existing.has(pathKey(row.path))) { row.status = "existing"; row.selected = false; continue }
      row.status = "importing"
      try {
        await client.catalog.createWorkspace(row.name, [{ path: row.path }])
        row.status = "imported"
        row.selected = false
        existing.add(pathKey(row.path))
      } catch (reason) {
        row.status = "available"
        row.error = message(reason)
      }
    }
  } catch (reason) { importError.value = message(reason) }
  finally { importing.value = false }
}

function close(): void {
  if (!importing.value) emit("close")
}
</script>

<template>
  <UiDialog class="flex w-[min(38rem,calc(100vw-2rem))] flex-col" described :prevent-close="importing" data-provider-workspace-import @close="close">
    <div class="mb-5 flex items-start gap-3">
      <FolderInput :size="22" :stroke-width="1.5" class="mt-0.5 shrink-0 text-ui-text-muted" aria-hidden="true" />
      <div class="min-w-0">
        <DialogTitle class="ui-dialog-title">{{ t("providers.workspaceImport.title") }}</DialogTitle>
        <DialogDescription class="ui-dialog-description">{{ t("providers.workspaceImport.description", { provider: provider.name, machine: machineName }) }}</DialogDescription>
      </div>
    </div>
    <p v-if="loading" role="status" class="m-0 flex items-center gap-2 py-6 text-sm text-ui-text-muted"><LoaderCircle :size="16" class="animate-spin" aria-hidden="true" />{{ t("providers.workspaceImport.loading") }}</p>
    <div v-else-if="discoveryError" class="flex items-center justify-between gap-3">
      <p role="alert" class="m-0 text-sm text-ui-danger">{{ message(discoveryError) }}</p>
      <UiButton type="button" @click="discover()">{{ t("folderPicker.retry") }}</UiButton>
    </div>
    <template v-else-if="discovery">
      <p v-for="warning in discovery.warnings" :key="warning" role="status" class="m-0 mb-3 text-sm text-ui-text-muted">{{ warning }}</p>
      <p v-if="!rows.length" role="status" class="m-0 py-6 text-sm text-ui-text-muted">{{ t(discovery.supported ? "providers.workspaceImport.empty" : "providers.workspaceImport.unsupported") }}</p>
      <UiScrollArea v-else class="max-h-[min(26rem,50dvh)] min-h-0 rounded-xl border border-ui-border" fade-size="sm">
        <label v-for="row in rows" :key="row.path" class="flex items-start gap-3 border-b border-ui-border p-3 last:border-b-0" :data-workspace-import-path="row.path">
          <UiCheckbox v-model="row.selected" :disabled="importing || row.status !== 'available'" :aria-label="t('providers.workspaceImport.select', { name: row.name })" class="mt-0.5" />
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium">{{ row.name }}</span>
            <span class="mt-1 block break-all font-mono text-xs text-ui-text-muted">{{ row.path }}</span>
            <span class="mt-1 block break-all text-xs text-ui-text-faint">{{ t("providers.workspaceImport.source", { source: row.source }) }}</span>
            <span v-if="row.status !== 'available'" role="status" class="mt-1 block text-xs text-ui-text-muted">{{ t(`providers.workspaceImport.${row.status}`) }}</span>
            <span v-if="row.error" role="alert" class="mt-1 block text-xs text-ui-danger">{{ row.error }}</span>
          </span>
        </label>
      </UiScrollArea>
      <p v-if="imported" role="status" class="m-0 mt-3 text-sm text-ui-text-muted">{{ t("providers.workspaceImport.importedCount", imported) }}</p>
    </template>
    <p v-if="importError" role="alert" class="m-0 mt-3 text-sm text-ui-danger">{{ importError }}</p>
    <div class="ui-dialog-actions flex-wrap">
      <UiButton type="button" :disabled="importing" data-workspace-import-close @click="close">{{ t(imported ? "providers.workspaceImport.done" : "providers.workspaceImport.skip") }}</UiButton>
      <UiButton v-if="rows.length" variant="primary" type="button" :disabled="loading || importing || !selected.length" data-import-selected @click="importSelected">{{ importing ? t("providers.workspaceImport.importing") : t("providers.workspaceImport.importSelected", selected.length) }}</UiButton>
    </div>
  </UiDialog>
</template>
