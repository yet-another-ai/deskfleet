<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { TerminalSummary } from "../../../../../../daemon/src/terminal-protocol.ts"
import { decodeTerminalBytes } from "../../services/terminal-client.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import TerminalSurface from "./TerminalSurface.vue"

export type TerminalConnection = "connecting" | "replaying" | "connected" | "disconnected" | "ended" | "error"

const props = defineProps<{ terminalId: string }>()
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
let size = { cols: 80, rows: 24 }
let attachment: ReturnType<typeof terminals.attach> | null = null
let resizeTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let activating: ReturnType<typeof terminals.attach> | null = null

const connection = computed((): [TerminalConnection, string] => {
  if (error.value) return ["error", error.value]
  if (connecting.value) return ["connecting", t("terminal.connecting")]
  if (attached.value && !replayed.value) return ["replaying", t("terminal.replaying")]
  if (sessionStatus.value === "interrupted") return ["ended", t("terminal.interrupted")]
  if (sessionStatus.value === "exited") return ["ended", exitCode.value === undefined ? t("terminal.ended") : t("terminal.exited", { code: exitCode.value })]
  return attached.value ? ["connected", t("terminal.connected")] : ["disconnected", t("terminal.disconnected")]
})
watch(connection, ([state, label]) => emit("connection", state, label), { immediate: true })

function failed(reason: unknown): void {
  if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason)
}

async function activate(): Promise<void> {
  const active = attachment
  if (!active || activating === active || !attached.value || !replayed.value || sessionStatus.value !== "running" || error.value) return
  activating = active
  try {
    await terminals.resize(props.terminalId, size.cols, size.rows)
    if (disposed || attachment !== active || !attached.value || sessionStatus.value !== "running") return
    interactive.value = true
    surface.value?.focus()
  } catch (reason) { failed(reason) }
  finally { if (activating === active) activating = null }
}

async function connect(): Promise<void> {
  attachment?.detach()
  clearTimeout(resizeTimer)
  connecting.value = true
  attached.value = false
  interactive.value = false
  replayed.value = false
  error.value = null
  sessionStatus.value = "running"
  exitCode.value = undefined
  const active = terminals.attach(props.terminalId, (event, acknowledge) => {
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
    attached.value = true
    sessionStatus.value = summary.status
    exitCode.value = summary.exitCode
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
  clearTimeout(resizeTimer)
  if (!interactive.value) return
  resizeTimer = setTimeout(() => {
    void terminals.resize(props.terminalId, size.cols, size.rows).catch(failed)
  }, 100)
}

function input(data: string): void {
  if (interactive.value) void terminals.input(props.terminalId, data).catch(failed)
}

onBeforeUnmount(() => {
  disposed = true
  clearTimeout(resizeTimer)
  attachment?.detach()
})
</script>

<template>
  <!-- History replay restores the program's title; scrollback size will become a Terminal setting. -->
  <div class="min-h-0 flex-1 overflow-hidden bg-ui-terminal">
    <TerminalSurface
      ref="surface"
      :interactive="interactive"
      @ready="ready"
      @input="input"
      @resize="resize"
      @title="title => emit('title', title)"
    />
  </div>
</template>
