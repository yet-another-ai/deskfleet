<script setup lang="ts">
import { useTimeoutFn, watchImmediate } from "@vueuse/core"
import { client as platformClient } from "@deskfleet/client/platform"
import { computed, onBeforeUnmount, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { TerminalSummary } from "../../../../../apps/daemon/src/terminal-protocol.ts"
import { decodeTerminalBytes, TerminalClient, type TerminalListener } from "../../services/terminal-client.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import TerminalSurface from "./TerminalSurface.vue"

export type TerminalConnection = "connecting" | "replaying" | "connected" | "disconnected" | "ended" | "error"

const props = defineProps<{ terminalId: string; readOnly?: boolean; independent?: boolean }>()
/** The surrounding tab shows the connection and the title the running program reports. */
const emit = defineEmits<{ connection: [state: TerminalConnection, label: string]; title: [title: string] }>()
const { t } = useI18n()
const terminals = useTerminalsStore()
const surface = useTemplateRef<InstanceType<typeof TerminalSurface>>("surface")
const attached = ref(false)
const connecting = ref(false)
const replayed = ref(false)
const interactive = ref(false)
const error = ref<string | null>(null)
const sessionStatus = ref<TerminalSummary["status"]>("running")
const exitCode = ref<number | undefined>()
const agentOwned = ref(false)
const readonly = computed(() => props.readOnly || agentOwned.value)
let size = { cols: 80, rows: 24 }
let attachment: ReturnType<typeof terminals.attach> | null = null
let disposed = false
let activating: ReturnType<typeof terminals.attach> | null = null
// Embedded tool output can be open alongside the same terminal's panel.
const independentClient = props.independent ? new TerminalClient(platformClient.terminal, (_state, detail) => {
  if (detail) failed(detail)
}) : undefined

watchImmediate(() => terminals.sessions.find(terminal => terminal.id === props.terminalId), summary => {
  if (!summary) return
  agentOwned.value = summary.kind === "acp"
  if (summary.status !== "running") {
    sessionStatus.value = summary.status
    exitCode.value = summary.exitCode
    interactive.value = false
  }
})

const connection = computed((): [TerminalConnection, string] => {
  if (error.value) return ["error", error.value]
  if (connecting.value) return ["connecting", t("terminal.connecting")]
  if (attached.value && !replayed.value) return ["replaying", t("terminal.replaying")]
  if (sessionStatus.value === "interrupted") return ["ended", t(agentOwned.value ? "terminal.agentInterrupted" : "terminal.interrupted")]
  if (sessionStatus.value === "exited") return ["ended", exitCode.value === undefined ? t("terminal.ended") : t("terminal.exited", { code: exitCode.value })]
  return attached.value ? ["connected", t("terminal.connected")] : ["disconnected", t("terminal.disconnected")]
})
const { start: scheduleResize, stop: cancelResize } = useTimeoutFn(() => {
  if (!readonly.value && interactive.value) void terminals.resize(props.terminalId, size.cols, size.rows).catch(failed)
}, 100, { immediate: false })
watchImmediate(connection, ([state, label]) => emit("connection", state, label))

function failed(reason: unknown): void {
  if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason)
}

async function activate(): Promise<void> {
  const active = attachment
  if (readonly.value || !active || activating === active || !attached.value || !replayed.value || sessionStatus.value !== "running" || error.value) return
  activating = active
  try {
    await terminals.resize(props.terminalId, size.cols, size.rows)
    if (disposed || attachment !== active || !attached.value || sessionStatus.value !== "running") return
    interactive.value = true
    surface.value?.focus()
  } catch (reason) { failed(reason) }
  finally { if (activating === active) activating = null }
}

function attach(listener: TerminalListener): ReturnType<typeof terminals.attach> {
  if (!independentClient) return terminals.attach(props.terminalId, listener)
  const unsubscribe = independentClient.subscribe(props.terminalId, listener)
  let detached = false
  const ready = platformClient.terminal.dial({ mode: "resume", terminalId: props.terminalId }).then(async () => {
    if (detached) throw new Error("Terminal attachment was cancelled")
    const summary = await independentClient.call("attach", { sessionId: props.terminalId })
    if (detached) throw new Error("Terminal attachment was cancelled")
    return summary
  })
  return { ready, detach: () => { detached = true; unsubscribe() } }
}

async function connect(): Promise<void> {
  attachment?.detach()
  cancelResize()
  connecting.value = true
  attached.value = false
  interactive.value = false
  replayed.value = false
  error.value = null
  sessionStatus.value = "running"
  exitCode.value = undefined
  const active = attach((event, acknowledge) => {
    if (disposed || attachment !== active) { acknowledge(); return }
    if (event.kind === "reset") {
      replayed.value = false
      interactive.value = false
      surface.value?.reset()
    } else if (event.kind === "output") {
      if (surface.value) surface.value.write(decodeTerminalBytes(event.data), acknowledge)
      else acknowledge()
    } else if (event.kind === "ready") {
      replayed.value = true
      void activate()
    } else if (event.kind === "exit") {
      interactive.value = false
      sessionStatus.value = "exited"
      exitCode.value = event.exitCode
    } else if (event.kind === "hungup") {
      interactive.value = false
      attached.value = false
    } else {
      interactive.value = false
      attached.value = false
      failed(event.error)
    }
  })
  attachment = active
  try {
    const summary = await active.ready
    if (disposed || attachment !== active) return
    agentOwned.value = summary.kind === "acp"
    attached.value = true
    if (sessionStatus.value === "running") {
      sessionStatus.value = summary.status
      exitCode.value = summary.exitCode
    }
    await activate()
  } catch (reason) {
    if (attachment === active) failed(reason)
  } finally {
    if (!disposed && attachment === active) connecting.value = false
  }
}

function ready(next: { cols: number; rows: number }): void {
  size = next
  void connect()
}

function resize(next: { cols: number; rows: number }): void {
  size = next
  cancelResize()
  if (readonly.value || !interactive.value) return
  scheduleResize()
}

function input(data: string): void {
  if (!readonly.value && interactive.value) void terminals.input(props.terminalId, data).catch(failed)
}

onBeforeUnmount(() => {
  disposed = true
  cancelResize()
  attachment?.detach()
  independentClient?.close()
})
</script>

<template>
  <!-- History replay restores the program's title; scrollback size will become a Terminal setting. -->
  <div class="min-h-0 flex-1 overflow-hidden bg-ui-terminal">
    <TerminalSurface
      ref="surface"
      :interactive="interactive && !readonly"
      @ready="ready"
      @input="input"
      @resize="resize"
      @title="title => emit('title', title)"
    />
  </div>
</template>
