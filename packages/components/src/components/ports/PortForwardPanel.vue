<script setup lang="ts">
import { ArrowRight, Cable, Check, Code2, Copy, Database, Globe, Plus, RefreshCw, Square } from "@lucide/vue"
import { useIntervalFn, useTimeoutFn, watchImmediate } from "@vueuse/core"
import { computed, onScopeDispose, ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import type { PortForward, PortForwardTarget, PortsApi } from "../../../../client/src/ports.ts"
import UiButton from "../common/UiButton.vue"
import UiDialog from "../common/UiDialog.vue"
import UiSelect from "../common/UiSelect.vue"

const props = defineProps<{ api: PortsApi; target: PortForwardTarget; machineName: string; online: boolean; active: boolean }>()
const { t } = useI18n()
const fieldId = useId()
const forwards = ref<PortForward[]>([])
const loading = ref(false)
const loaded = ref(false)
const pending = ref<string>()
const listError = ref("")
const actionError = ref("")
const dialogError = ref("")
const dialogOpen = ref(false)
const targetHost = ref("127.0.0.1")
const targetPort = ref("")
const localPort = ref("")
const copiedText = ref("")
const { start: resetCopiedLater, stop: cancelCopiedReset } = useTimeoutFn(() => { copiedText.value = "" }, 1500, { immediate: false })
const canAdd = computed(() => props.online && !pending.value)
const examples = [
  { icon: Globe, title: "ports.webTitle", description: "ports.webDescription" },
  { icon: Database, title: "ports.databaseTitle", description: "ports.databaseDescription" },
  { icon: Code2, title: "ports.developmentTitle", description: "ports.developmentDescription" },
]
const localAddress = (forward: PortForward) => `${forward.localHost}:${forward.localPort}`
const remoteAddress = (forward: PortForward) => `${forward.targetHost === "::1" ? "[::1]" : forward.targetHost}:${forward.targetPort}`
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
let scope = 0
let revision = 0

async function refresh(): Promise<void> {
  const api = props.api
  if (!props.active || loading.value || pending.value) return
  const currentScope = scope, currentRevision = ++revision
  const { teamId, machineId } = props.target
  loading.value = true
  try {
    const values = await api.list()
    if (currentScope !== scope || currentRevision !== revision) return
    forwards.value = values.filter(value => value.target.teamId === teamId && value.target.machineId === machineId)
    listError.value = ""
  } catch (reason) {
    if (currentScope === scope && currentRevision === revision) listError.value = message(reason)
  } finally {
    if (currentScope === scope && currentRevision === revision) { loading.value = false; loaded.value = true }
  }
}

const { pause, resume } = useIntervalFn(() => { void refresh() }, 3000, { immediate: false })
// Roster refreshes replace target objects without changing the forwarding scope.
watchImmediate([() => props.api, () => props.target.teamId, () => props.target.machineId], () => {
  scope++
  revision++
  forwards.value = []
  loading.value = false
  loaded.value = false
  pending.value = undefined
  listError.value = actionError.value = dialogError.value = ""
  copiedText.value = ""
  dialogOpen.value = false
  void refresh()
}, { flush: "sync" })
watchImmediate(() => props.active, enabled => {
  if (enabled) { resume(); void refresh() }
  else pause()
})
onScopeDispose(() => { scope++; revision++ })

function openDialog(): void {
  targetHost.value = "127.0.0.1"
  targetPort.value = localPort.value = dialogError.value = ""
  dialogOpen.value = true
}
function beginMutation(id: string): number {
  revision++ // A list read started before this mutation must not restore stale rows.
  loading.value = false
  pending.value = id
  return scope
}
async function start(): Promise<void> {
  if (!canAdd.value) return
  const localText = String(localPort.value).trim()
  const remote = Number(targetPort.value), local = localText === "" ? 0 : Number(localText)
  if (!Number.isInteger(remote) || remote < 1 || remote > 65535
    || !Number.isInteger(local) || local < (localText === "" ? 0 : 1) || local > 65535) {
    dialogError.value = t("ports.invalidPort")
    return
  }
  const api = props.api, currentScope = beginMutation("start")
  dialogError.value = ""
  try {
    // Build a plain DTO: props.target may be a Vue proxy and crosses Electron IPC.
    const forward = await api.start({
      target: { teamId: props.target.teamId, machineId: props.target.machineId },
      targetHost: targetHost.value === "::1" ? "::1" : "127.0.0.1", targetPort: remote, localPort: local,
    })
    if (currentScope !== scope) return
    forwards.value.push(forward)
    actionError.value = ""
    dialogOpen.value = false
  } catch (reason) {
    if (currentScope === scope) dialogError.value = message(reason)
  } finally {
    if (currentScope === scope) pending.value = undefined
  }
}
async function stop(forward: PortForward): Promise<void> {
  if (pending.value) return
  const api = props.api, currentScope = beginMutation(forward.id)
  actionError.value = ""
  try {
    await api.stop(forward.id)
    if (currentScope === scope) forwards.value = forwards.value.filter(value => value.id !== forward.id)
  } catch (reason) {
    if (currentScope === scope) actionError.value = message(reason)
  } finally {
    if (currentScope === scope) pending.value = undefined
  }
}
async function copyAddress(forward: PortForward): Promise<void> {
  const currentScope = scope
  cancelCopiedReset()
  copiedText.value = ""
  actionError.value = ""
  const address = localAddress(forward)
  try { await navigator.clipboard.writeText(address) }
  catch { if (currentScope === scope) actionError.value = t("ports.copyFailed"); return }
  if (currentScope === scope) { copiedText.value = address; resetCopiedLater() }
}
</script>

<template>
  <section data-port-forwards class="port-forwards min-w-0 flex-1 py-2">
    <div class="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <h2 class="m-0 text-base font-semibold">{{ t('ports.title') }}</h2>
        <p class="mb-0 mt-2 text-sm leading-relaxed text-ui-text-muted">{{ t('ports.description', { machine: machineName }) }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <UiButton variant="ghost" size="icon" data-ports-refresh :label="t('ports.refresh')" :disabled="loading || !!pending" @click="refresh"><RefreshCw :size="15" aria-hidden="true" /></UiButton>
        <UiButton v-if="forwards.length" variant="primary" data-ports-add :disabled="!canAdd" @click="openDialog"><Plus :size="15" aria-hidden="true" />{{ t('ports.add') }}</UiButton>
      </div>
    </div>

    <p v-if="!online" role="status" class="mb-4 rounded-lg bg-ui-warning/10 px-4 py-3 text-sm text-ui-warning">{{ t('ports.offline') }}</p>
    <p v-if="listError || actionError" role="alert" class="mb-4 break-words rounded-lg bg-ui-danger/10 px-4 py-3 text-sm text-ui-danger">{{ actionError || listError }}</p>
    <div v-if="!loaded && loading" role="status" class="flex min-h-56 items-center justify-center gap-2 text-sm text-ui-text-muted"><RefreshCw :size="17" class="animate-spin" aria-hidden="true" />{{ t('ports.loading') }}</div>
    <div v-else-if="!forwards.length" class="rounded-xl border border-ui-border bg-ui-surface px-5 py-8 text-center">
      <div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-ui-accent/10 text-ui-accent"><Cable :size="24" :stroke-width="1.5" aria-hidden="true" /></div>
      <h3 class="m-0 text-base font-medium">{{ t('ports.emptyTitle') }}</h3>
      <p class="mb-6 mt-2 text-sm text-ui-text-muted">{{ t('ports.emptyDescription') }}</p>
      <div class="ports-examples mx-auto mb-7 grid max-w-4xl grid-cols-1 gap-3 text-left">
        <div v-for="example in examples" :key="example.title" class="rounded-xl border border-ui-border p-4">
          <component :is="example.icon" :size="22" :stroke-width="1.5" class="mb-4 text-ui-accent" aria-hidden="true" />
          <h4 class="m-0 text-sm font-medium">{{ t(example.title) }}</h4>
          <p class="mb-0 mt-2 text-xs leading-relaxed text-ui-text-muted">{{ t(example.description) }}</p>
        </div>
      </div>
      <UiButton variant="primary" data-ports-add :disabled="!canAdd" @click="openDialog"><Plus :size="15" aria-hidden="true" />{{ t('ports.add') }}</UiButton>
    </div>
    <ul v-else class="m-0 grid list-none gap-3 p-0">
      <li v-for="forward in forwards" :key="forward.id" :data-forward-id="forward.id" class="rounded-xl border border-ui-border bg-ui-surface p-4">
        <div class="mb-4 flex items-center justify-between gap-3">
          <span class="flex items-center gap-2 text-xs text-ui-text-muted"><span class="ui-status-dot ui-status-live text-ui-success" />{{ t('ports.active') }}<span class="rounded bg-ui-hover px-1.5 py-0.5 text-[10px] font-medium">TCP</span></span>
          <UiButton size="sm" :loading="pending === forward.id" :disabled="!!pending" data-ports-stop @click="stop(forward)"><Square v-if="pending !== forward.id" :size="12" aria-hidden="true" />{{ t('ports.stop') }}</UiButton>
        </div>
        <div class="ports-endpoints grid min-w-0 grid-cols-1 gap-3">
          <div class="min-w-0"><p class="mb-1.5 mt-0 text-xs text-ui-text-muted">{{ t('ports.localAddress') }}</p><div class="flex items-center gap-2"><code class="break-all text-sm font-medium">{{ localAddress(forward) }}</code><UiButton variant="ghost" size="icon" data-ports-copy :label="t(copiedText === localAddress(forward) ? 'ports.copied' : 'ports.copy')" @click="copyAddress(forward)"><Check v-if="copiedText === localAddress(forward)" :size="14" aria-hidden="true" /><Copy v-else :size="14" aria-hidden="true" /></UiButton></div></div>
          <ArrowRight :size="18" class="ports-arrow self-center text-ui-text-faint" aria-hidden="true" />
          <div class="min-w-0"><p class="mb-1.5 mt-0 text-xs text-ui-text-muted">{{ t('ports.destination') }}</p><code class="break-all text-sm">{{ remoteAddress(forward) }}</code><p class="mb-0 mt-1 truncate text-xs text-ui-text-muted">{{ machineName }}</p></div>
        </div>
      </li>
    </ul>
    <div class="mt-5 space-y-1.5 px-1 text-xs leading-relaxed text-ui-text-muted">
      <p class="m-0">{{ t('ports.loopbackNote') }}</p>
      <p class="m-0">{{ t('ports.lifetime') }}</p>
    </div>

    <UiDialog v-model:open="dialogOpen" :title="t('ports.add')" :prevent-close="pending === 'start'" class="w-[min(440px,calc(100vw-2rem))] p-6">
      <form data-ports-form @submit.prevent="start">
        <h3 class="m-0 text-base font-semibold">{{ t('ports.add') }}</h3>
        <p class="mb-5 mt-2 text-sm leading-relaxed text-ui-text-muted">{{ t('ports.dialogDescription') }}</p>
        <div class="space-y-4">
          <div><label :for="`${fieldId}-host`" class="mb-1.5 block text-xs font-medium">{{ t('ports.remoteHost') }}</label><UiSelect :id="`${fieldId}-host`" v-model="targetHost" name="targetHost" :disabled="!!pending" :options="[{ value: '127.0.0.1', label: '127.0.0.1' }, { value: '::1', label: '::1' }]" class="w-full" /></div>
          <div><label :for="`${fieldId}-remote`" class="mb-1.5 block text-xs font-medium">{{ t('ports.remotePort') }}</label><input :id="`${fieldId}-remote`" v-model="targetPort" name="targetPort" type="number" min="1" max="65535" step="1" required :disabled="!!pending" class="ui-input w-full" placeholder="3000"></div>
          <div><label :for="`${fieldId}-local`" class="mb-1.5 block text-xs font-medium">{{ t('ports.localPort') }}</label><input :id="`${fieldId}-local`" v-model="localPort" name="localPort" type="number" min="1" max="65535" step="1" :disabled="!!pending" class="ui-input w-full" :placeholder="t('ports.automatic')" :aria-describedby="`${fieldId}-automatic`"><p :id="`${fieldId}-automatic`" class="mb-0 mt-1.5 text-xs text-ui-text-muted">{{ t('ports.automaticHint') }}</p></div>
        </div>
        <p v-if="!online" role="status" class="mt-4 text-sm text-ui-warning">{{ t('ports.offline') }}</p>
        <p v-if="dialogError" role="alert" class="mb-0 mt-4 break-words text-sm text-ui-danger">{{ dialogError }}</p>
        <div class="mt-6 flex justify-end gap-2"><UiButton :disabled="!!pending" @click="dialogOpen = false">{{ t('ports.cancel') }}</UiButton><UiButton type="submit" variant="primary" data-ports-start :loading="pending === 'start'" :disabled="!canAdd">{{ t('ports.start') }}</UiButton></div>
      </form>
    </UiDialog>
  </section>
</template>

<style scoped>
.port-forwards { container-type: inline-size; }
.ports-arrow { display: none; }
@container (min-width: 520px) {
  .ports-examples { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .ports-endpoints { grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 1.5rem; }
  .ports-arrow { display: block; }
}
</style>
