<script setup lang="ts">
import { ArrowLeft, ArrowRight, File, Folder, RotateCcw, X } from "@lucide/vue"
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { FileConflict, FileEntry, FileLocation, FilesApi, FileTarget, FileTransfer } from "../../../../client/src/files.ts"
import { fileSize } from "../../services/file-format.ts"
import FileBrowserPane from "./FileBrowserPane.vue"
import IconButton from "../common/IconButton.vue"
const props = defineProps<{ api: FilesApi; target: FileTarget; machineName: string }>()
const { t } = useI18n()
const local: FileTarget = { kind: "local" }
const paths = ref<{ local?: FileLocation; remote?: FileLocation }>({})
const selection = ref<{ local: FileEntry[]; remote: FileEntry[] }>({ local: [], remote: [] })
const transfers = ref<FileTransfer[]>([])
const error = ref<string>()
const busy = ref(false)
const revision = ref(0)
let disposed = false
let eventRevision = 0
const relevant = (target: FileTarget) => target.kind === props.target.kind && (target.kind === "local" || (props.target.kind === "machine" && target.machineId === props.target.machineId && target.teamId === props.target.teamId))
const tasks = computed(() => transfers.value.filter(task => relevant(task.source.target) || relevant(task.destination.target)))
const activeCount = computed(() => tasks.value.filter(task => !["completed", "failed", "cancelled"].includes(task.state)).length)
const progress = (task: FileTransfer) => task.totalBytes ? Math.min(100, Math.floor(task.transferredBytes / task.totalBytes * 100)) : task.state === "completed" ? 100 : 0
function apply(next: FileTransfer[]): void {
  if (disposed) return
  const finished = next.some(task => task.state === "completed" && transfers.value.some(previous => previous.id === task.id && previous.state !== "completed"))
  transfers.value = next
  if (finished) ++revision.value
}
const unsubscribe = props.api.onChanged(next => { ++eventRevision; apply(next) })
async function operation(action: () => Promise<unknown>): Promise<void> {
  if (busy.value) return
  busy.value = true; error.value = undefined
  try { await action() } catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { if (!disposed) busy.value = false }
}
function transfer(side: "local" | "remote"): void {
  const other = side === "local" ? "remote" : "local"
  const destination = paths.value[other]
  const source = paths.value[side]
  if (!destination || !source) return
  const entries = [...selection.value[side]]
  void operation(async () => {
    for (const entry of entries) {
      await props.api.enqueue({ kind: entry.kind, source: { target: source.target, path: entry.path }, destination })
      selection.value[side] = selection.value[side].filter(selected => selected.path !== entry.path)
    }
  })
}
function retry(task: FileTransfer, conflict?: FileConflict): void { void operation(() => props.api.retry(task.id, conflict)) }
onMounted(() => {
  const version = eventRevision
  void operation(async () => { const next = await props.api.transfers(); if (version === eventRevision) apply(next) })
})
onBeforeUnmount(() => { disposed = true; unsubscribe() })
</script>

<template>
  <div class="file-transfer-container flex min-h-0 min-w-0 flex-1 flex-col">
    <div class="file-transfer-panel flex min-w-0 flex-1 flex-col">
      <div class="file-transfer-grid grid flex-1 grid-cols-1 gap-3">
        <FileBrowserPane :api="api" :target="local" :name="t('files.local')" :revision="revision" :selection="selection.local" @selection="selection.local = $event" @location="paths.local = $event" />
        <div class="file-transfer-actions flex items-center justify-center gap-2">
          <IconButton :icon="ArrowRight" :label="t('files.send')" :disabled="busy || !selection.local.length || !paths.remote" class="file-transfer-arrow" @click="transfer('local')" />
          <IconButton :icon="ArrowLeft" :label="t('files.receive')" :disabled="busy || !selection.remote.length || !paths.local" class="file-transfer-arrow" @click="transfer('remote')" />
        </div>
        <FileBrowserPane :api="api" :target="target" :name="machineName" :revision="revision" :selection="selection.remote" @selection="selection.remote = $event" @location="paths.remote = $event" />
      </div>
      <section class="mt-5 shrink-0" :aria-label="t('files.queue')">
        <div class="mb-2 text-sm font-medium">{{ t('files.queue') }}<span v-if="activeCount" class="ml-1.5 text-xs font-normal text-ui-text-muted">({{ activeCount }})</span></div>
        <p v-if="!tasks.length" class="m-0 py-3 text-sm text-ui-text-muted">{{ t('files.noTransfers') }}</p>
        <div v-else class="max-h-64 overflow-y-auto border-t border-ui-border">
          <div v-for="task in tasks" :key="task.id" class="border-b border-ui-border last:border-0" :data-transfer-id="task.id">
            <div class="file-transfer-row grid grid-cols-[minmax(0,1fr)_1rem_3.25rem_4.75rem_1.75rem] items-center gap-2 py-2.5 text-xs">
              <div class="flex min-w-0 items-center gap-2"><component :is="task.kind === 'directory' ? Folder : File" :size="15" class="shrink-0 text-ui-text-muted" aria-hidden="true" /><span class="truncate text-[13px]" :title="task.name">{{ task.name }}</span></div>
              <component :is="task.source.target.kind === 'local' ? ArrowRight : ArrowLeft" :size="14" class="text-ui-text-muted" :aria-label="t(task.source.target.kind === 'local' ? 'files.send' : 'files.receive')" />
              <div v-if="task.state === 'transferring'" class="flex items-center gap-2 tabular-nums" role="progressbar" :aria-label="task.name" :aria-valuenow="progress(task)" aria-valuemin="0" aria-valuemax="100" :title="`${fileSize(task.transferredBytes)} / ${fileSize(task.totalBytes ?? 0)}`"><div class="file-transfer-progress h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-ui-hover"><div class="h-full bg-ui-accent" :style="{ width: `${progress(task)}%` }" /></div>{{ progress(task) }}%</div>
              <span v-else class="truncate" :class="task.state === 'failed' && 'text-ui-danger'" :title="task.error">{{ t(`files.state.${task.state}`) }}</span>
              <span class="text-right tabular-nums text-ui-text-muted">{{ task.state === 'transferring' ? `${fileSize(task.bytesPerSecond)}/s` : '' }}</span>
              <IconButton v-if="['failed', 'cancelled'].includes(task.state)" :icon="RotateCcw" :label="t('files.retry')" :disabled="busy" @click="retry(task)" />
              <IconButton v-else-if="task.state !== 'completed'" :icon="X" :label="t('files.cancel')" :disabled="busy" @click="operation(() => api.cancel(task.id))" />
            </div>
            <div v-if="task.state === 'conflict'" class="flex flex-wrap items-center gap-2 pb-3 pl-6">
              <button type="button" class="ui-button" :disabled="busy" @click="retry(task, 'rename')">{{ t('files.keepBoth') }}</button>
              <button type="button" class="ui-button" :disabled="busy" @click="retry(task, 'skip')">{{ t('files.skip') }}</button>
              <button type="button" class="ui-button-danger" :disabled="busy" @click="retry(task, 'replace')">{{ t('files.replace') }}</button>
            </div>
            <p v-if="['failed', 'conflict', 'cancelled'].includes(task.state) && task.error" class="mt-0 mb-2 break-words pl-6 text-xs text-ui-danger" role="alert">{{ task.error }}</p>
          </div>
        </div>
      </section>
      <p v-if="error" class="mb-0 shrink-0 break-words text-sm text-ui-danger" role="alert">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.file-transfer-container { container: files / inline-size; }
.file-transfer-arrow { transform: rotate(90deg); }
.file-transfer-progress { display: none; }

@container files (min-width: 36rem) {
  .file-transfer-panel, .file-transfer-grid { min-height: 0; }
  .file-transfer-grid { grid-template-columns: minmax(0, 1fr) 2rem minmax(0, 1fr); }
  .file-transfer-actions { flex-direction: column; }
  .file-transfer-arrow { transform: none; }
  .file-transfer-row { grid-template-columns: minmax(0, 1fr) 1rem minmax(7rem, 0.65fr) 5.5rem 1.75rem; }
  .file-transfer-progress { display: block; }
}
</style>
