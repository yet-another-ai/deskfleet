<script setup lang="ts">
import { LoaderCircle, RotateCw } from "@lucide/vue"
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentProviderInput, ProviderProbeResult } from "../../../../../apps/daemon/src/provider-protocol.ts"
import type { TerminalSummary } from "../../../../../apps/daemon/src/terminal-protocol.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import IconButton from "../common/IconButton.vue"
import LiveTerminal, { type TerminalConnection } from "../terminal/LiveTerminal.vue"

const props = defineProps<{
  provider: AgentProviderInput | null
  machineName: string
  disabled?: boolean
  probe(provider: AgentProviderInput): Promise<ProviderProbeResult>
  install(provider: AgentProviderInput): Promise<TerminalSummary>
  login(provider: AgentProviderInput): Promise<TerminalSummary>
}>()
const emit = defineEmits<{ busy: [value: boolean]; resolved: [path: string | undefined]; binaryPath: [path: string]; editPath: [] }>()
const { t } = useI18n()
const terminals = useTerminalsStore()
const result = ref<ProviderProbeResult | null>(null)
const probing = ref(false)
const probeError = ref<string | null>(null)
const error = ref<string | null>(null)
const starting = ref(false)
const finishing = ref(false)
const stopping = ref(false)
const terminalConnection = ref<string | null>(null)
const operation = ref<{ kind: "install" | "login"; terminal: TerminalSummary; completed: boolean } | null>(null)
const busy = computed(() => starting.value || finishing.value || stopping.value || !!(operation.value && !operation.value.completed))
const running = computed(() => starting.value || !!(operation.value && !operation.value.completed))
const terminal = computed(() => {
  const active = operation.value
  return active && (terminals.sessions.find(value => value.id === active.terminal.id) ?? active.terminal)
})
const custom = computed(() => props.provider?.template === "acp")
const actionsDisabled = computed(() => busy.value || probing.value || !!props.disabled)
const canInstall = computed(() => !custom.value && !!result.value && result.value.status !== "found" && result.value.installable)
const canLogin = computed(() => !custom.value && result.value?.status === "found" && result.value.loginAvailable)
const canSetPath = computed(() => !!result.value && result.value.status !== "found" && !canInstall.value)

/** One summary line for the probe, phrased for the person configuring the agent rather than for debugging. */
const summary = computed((): { tone: "success" | "warning" | "danger" | "muted"; title: string; detail?: string } | null => {
  if (probeError.value) return { tone: "danger", title: t("providers.setup.probeFailed", { machine: props.machineName }), detail: probeError.value }
  const found = result.value
  if (!found) return null
  if (found.status === "found") {
    if (!custom.value && found.auth === "unauthenticated") return { tone: "warning", title: t("providers.setup.signedOut"), detail: t("providers.setup.signedOutDetail") }
    const ready = custom.value || found.auth === "authenticated"
    return { tone: "success", title: t(ready ? "providers.setup.ready" : "providers.setup.installed"), detail: found.version }
  }
  if (found.status === "invalid") return { tone: "danger", title: t("providers.setup.invalid"), detail: found.message }
  return {
    tone: "muted", title: t("providers.setup.missing"),
    detail: found.installable && !custom.value ? t("providers.setup.missingDetail", { machine: props.machineName }) : found.installMessage,
  }
})
const dot = { success: "bg-ui-success", warning: "bg-ui-warning", danger: "bg-ui-danger", muted: "bg-ui-text-faint" }
let revision = 0
let probeTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false

watch(busy, value => emit("busy", value), { immediate: true, flush: "sync" })

async function probe(installed = false): Promise<void> {
  clearTimeout(probeTimer)
  const provider = props.provider
  if (!provider || props.disabled || disposed) return
  const request = ++revision
  probing.value = true
  result.value = null
  emit("resolved", undefined)
  probeError.value = null
  try {
    // A missing custom path must not hide a successful install in the vendor's default location.
    const found = await props.probe(installed ? { ...provider, binaryPath: undefined } : provider)
    if (request !== revision || disposed) return
    result.value = found
    if (installed && found.status === "found" && found.binaryPath) emit("binaryPath", found.binaryPath)
    emit("resolved", found.status === "found" ? found.binaryPath : undefined)
    if (installed && found.status !== "found") error.value = t("providers.setup.installNotFound")
  } catch (reason) {
    if (request === revision && !disposed) probeError.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    if (request === revision && !disposed) probing.value = false
  }
}

watch(() => [props.provider?.template, props.provider?.binaryPath, JSON.stringify(props.provider?.env), props.disabled] as const, (value, previous) => {
  if (finishing.value && operation.value?.kind === "install" && value[1] === result.value?.binaryPath) return
  revision++
  clearTimeout(probeTimer)
  result.value = null
  probing.value = false
  probeError.value = null
  emit("resolved", undefined)
  if (!busy.value) { error.value = null; operation.value = null; terminalConnection.value = null }
  if (!props.provider || props.disabled || busy.value) return
  if (!previous || value[0] !== previous[0] || value[3] !== previous[3]) void probe()
  else {
    probing.value = true
    probeTimer = setTimeout(() => { void probe() }, 300)
  }
}, { immediate: true, flush: "sync" })

async function start(kind: "install" | "login"): Promise<void> {
  if (actionsDisabled.value || !props.provider || !(kind === "install" ? canInstall.value : canLogin.value)) return
  const provider = { ...props.provider, binaryPath: kind === "login" ? result.value!.binaryPath : props.provider.binaryPath }
  starting.value = true
  error.value = null
  terminalConnection.value = null
  operation.value = null
  try {
    const summary = await props[kind](provider)
    if (!disposed) operation.value = { kind, terminal: summary, completed: false }
  } catch (reason) {
    if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason)
  } finally { if (!disposed) starting.value = false }
}

watch(terminal, async summary => {
  const active = operation.value
  if (!active || active.completed || !summary || summary.status === "running" || stopping.value) return
  active.completed = true
  finishing.value = true
  if (summary.status === "exited" && summary.exitCode === 0) {
    await probe(active.kind === "install")
    // The refreshed status reports the outcome; the output is only worth keeping when something went wrong.
    if (!disposed && !error.value && operation.value === active) operation.value = null
  } else {
    error.value = summary.status === "interrupted"
      ? t("providers.setup.interrupted")
      : t("providers.setup.failed", { code: summary.exitCode ?? t("providers.setup.unknownExit") })
  }
  if (!disposed) finishing.value = false
}, { deep: true })

async function stop(): Promise<void> {
  const active = operation.value
  if (!active || active.completed || stopping.value) return
  stopping.value = true
  error.value = null
  try {
    await terminals.hangup(active.terminal.id)
    if (disposed) return
    active.completed = true
    operation.value = null
    await probe()
  } catch (reason) {
    if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason)
  } finally { if (!disposed) stopping.value = false }
}

function connection(state: TerminalConnection, label: string): void {
  terminalConnection.value = state === "error" || state === "disconnected" ? label : null
}

onBeforeUnmount(() => { disposed = true; revision++; clearTimeout(probeTimer) })
</script>

<template>
  <section class="rounded-xl border border-ui-border text-sm" :aria-label="t('providers.setup.title', { machine: machineName })" data-provider-setup>
    <div class="flex min-h-14 items-center gap-3 px-3.5 py-2.5">
      <template v-if="probing">
        <LoaderCircle :size="14" :stroke-width="2" class="shrink-0 animate-spin text-ui-text-muted" aria-hidden="true" />
        <p role="status" class="m-0 min-w-0 flex-1 text-ui-text-muted">{{ t("providers.setup.probing", { machine: machineName }) }}</p>
      </template>
      <template v-else-if="summary">
        <span class="h-2 w-2 shrink-0 rounded-full" :class="dot[summary.tone]" aria-hidden="true" />
        <div role="status" class="min-w-0 flex-1" :data-provider-status="probeError ? 'error' : result?.status">
          <p class="m-0 font-medium" :title="result?.binaryPath">{{ summary.title }}</p>
          <p v-if="summary.detail" class="m-0 mt-0.5 break-words text-xs text-ui-text-muted" data-provider-status-detail>{{ summary.detail }}</p>
        </div>
      </template>
      <p v-else class="m-0 min-w-0 flex-1 text-ui-text-muted">{{ t("providers.setup.unavailable") }}</p>
      <!-- The running operation owns the card's only action, Stop, until it finishes. -->
      <div v-if="!running" class="flex shrink-0 items-center gap-1.5">
        <IconButton :icon="RotateCw" :label="t('providers.setup.refresh')" :disabled="actionsDisabled || !provider" data-provider-probe @click="probe()" />
        <button v-if="canSetPath" type="button" class="ui-text-button cursor-pointer hover:bg-ui-hover" :disabled="busy || disabled" data-provider-set-path @click="emit('editPath')">{{ t("providers.setup.setPath") }}</button>
        <button v-if="canInstall" type="button" class="ui-button" :disabled="actionsDisabled" data-provider-install @click="start('install')">{{ t("providers.setup.install") }}</button>
        <button v-if="canLogin" type="button" :class="result?.auth === 'authenticated' ? 'ui-text-button cursor-pointer hover:bg-ui-hover' : 'ui-button'" :disabled="actionsDisabled" data-provider-login @click="start('login')">{{ t("providers.setup.login") }}</button>
      </div>
    </div>
    <p v-if="error" role="alert" class="m-0 border-t border-ui-border px-3.5 py-2.5 whitespace-pre-wrap break-words text-[13px] text-ui-danger">{{ error }}</p>
    <div v-if="running || operation" class="flex flex-col gap-2.5 border-t border-ui-border px-3.5 py-3" data-provider-operation>
      <div class="flex min-h-7 items-center gap-2">
        <LoaderCircle v-if="running" :size="14" :stroke-width="2" class="shrink-0 animate-spin text-ui-text-muted" aria-hidden="true" />
        <p role="status" class="m-0 min-w-0 flex-1 text-[13px] text-ui-text-muted">
          {{ starting ? t("providers.setup.starting") : running ? t(operation?.kind === "install" ? "providers.setup.installing" : "providers.setup.loggingIn") : t("providers.setup.output") }}
        </p>
        <button v-if="operation && !operation.completed" type="button" class="ui-button" :disabled="stopping" data-provider-stop @click="stop">{{ t("providers.setup.stop") }}</button>
      </div>
      <p v-if="terminalConnection" role="alert" class="m-0 text-xs text-ui-danger">{{ terminalConnection }}</p>
      <div v-if="operation" class="flex h-56 min-h-0 overflow-hidden rounded-lg border border-ui-border" data-provider-terminal>
        <LiveTerminal :key="operation.terminal.id" :terminal-id="operation.terminal.id" @connection="connection" />
      </div>
    </div>
  </section>
</template>
