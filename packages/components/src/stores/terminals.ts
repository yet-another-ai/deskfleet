import { usePlatformClient } from "../composables/usePlatformClient.ts"
import { captureAnalyticsContext } from "../services/analytics.ts"
import { defineStore } from "pinia"
import { computed, onScopeDispose, reactive, ref } from "vue"
import type { RelayDeniedReason } from "../../../client/src/relay.ts"
import type { TerminalSummary } from "../../../../apps/daemon/src/terminal-protocol.ts"
import { TerminalClient, type TerminalConnectionState, type TerminalListener } from "../services/terminal-client.ts"

interface TerminalTransportStatus {
  state: TerminalConnectionState
  error: string | null
  relayDeniedReason?: RelayDeniedReason
}

/** Shell lifecycle uses signaling; Mux gives each terminal its own stream on one peer. */
export const useTerminalsStore = defineStore("terminals", () => {
  const platformClient = usePlatformClient()
  const sessions = ref<TerminalSummary[]>([])
  /** Whether the daemon's complete terminal list has been loaded at least once. */
  const loaded = ref(false)
  const sharedState = ref<TerminalConnectionState>("idle")
  const streamStates = ref<Record<string, TerminalTransportStatus>>({})
  // A live terminal remains usable during signaling loss even if a sibling fails.
  const state = computed<TerminalConnectionState>(() => {
    const states = [sharedState.value, ...Object.values(streamStates.value).map(status => status.state)]
    return states.includes("connected") ? "connected" : states.includes("connecting") ? "connecting" : states.includes("error") ? "error" : "idle"
  })
  const error = ref<string | null>(null)
  const relayDeniedReason = ref<RelayDeniedReason>()
  /** The shell last shown in each terminal window owner. */
  const selected = ref<Record<string, string>>({})
  /** The title each shell's running program last reported; replay restores it after reattaching. */
  const titles = ref<Record<string, string>>({})
  let client: TerminalClient | null = null
  const streams = new Map<string, TerminalClient>()
  const attachments = new Map<string, symbol>()
  let refreshing: Promise<void> | null = null
  let refreshChanges: Map<string, TerminalSummary | null> | null = null
  const opening = new Map<string, Promise<TerminalSummary>>()
  const unsubscribe = platformClient.terminal.onSessionEvent((event) => {
    if (event.kind === "terminalChanged") remember(event.terminal)
    else forget(event.terminalId)
  })

  function transportStatus(sessionId: string): TerminalTransportStatus {
    return streamStates.value[sessionId] ?? { state: sharedState.value, error: error.value, relayDeniedReason: relayDeniedReason.value }
  }

  function newClient(sessionId?: string): TerminalClient {
    const status = sessionId ? reactive<TerminalTransportStatus>({ state: "idle", error: null }) : undefined
    if (sessionId && status) streamStates.value[sessionId] = status
    return new TerminalClient(platformClient.terminal, (next, detail, relayReason) => {
      if (status) {
        status.state = next
        status.error = detail ?? null
        status.relayDeniedReason = relayReason
      } else {
        sharedState.value = next
        error.value = detail ?? null
        relayDeniedReason.value = relayReason
      }
    }, (event) => {
      if (event.kind !== "exit") return
      const terminal = sessions.value.find(({ id }) => id === event.sessionId)
      if (terminal) remember({ ...terminal, status: "exited", exitCode: event.exitCode })
    })
  }

  function connection(sessionId: string): TerminalClient {
    const existing = streams.get(sessionId)
    if (existing) return existing
    if (platformClient.terminal.multiplexed) {
      const stream = newClient(sessionId)
      streams.set(sessionId, stream)
      return stream
    }
    return client ??= newClient()
  }

  function remember(summary: TerminalSummary): TerminalSummary {
    refreshChanges?.set(summary.id, summary)
    const index = sessions.value.findIndex(({ id }) => id === summary.id)
    if (index === -1) sessions.value.push(summary)
    else sessions.value[index] = summary
    return summary
  }

  function forget(sessionId: string): void {
    refreshChanges?.set(sessionId, null)
    sessions.value = sessions.value.filter(({ id }) => id !== sessionId)
  }

  function refresh(): Promise<void> {
    if (refreshing) return refreshing
    const changes = new Map<string, TerminalSummary | null>()
    refreshChanges = changes
    refreshing = platformClient.terminal.list().then((result) => {
      // Events and completed commands received after the request supersede its snapshot.
      const merged = new Map(result.map(summary => [summary.id, summary]))
      for (const [id, summary] of changes) {
        if (summary) merged.set(id, summary)
        else merged.delete(id)
      }
      sessions.value = [...merged.values()]
      loaded.value = true
      error.value = null
      relayDeniedReason.value = undefined
    }).catch((reason: unknown) => {
      error.value = reason instanceof Error ? reason.message : String(reason)
      relayDeniedReason.value = undefined
    }).finally(() => { refreshing = null; refreshChanges = null })
    return refreshing
  }

  /** A `worktreeId` makes the terminal its Session's; without `cwd` it starts in the Worktree's first directory. */
  async function create(options: { cwd?: string; worktreeId?: string; cols?: number; rows?: number } = {}): Promise<TerminalSummary> {
    error.value = null
    relayDeniedReason.value = undefined
    const track = captureAnalyticsContext()
    const { cols = 80, rows = 24, cwd, worktreeId } = options
    const summary = remember(await platformClient.terminal.dial({
      mode: "create", terminalId: crypto.randomUUID(), cols, rows,
      ...(cwd === undefined ? {} : { cwd }), ...(worktreeId === undefined ? {} : { worktreeId }),
    }))
    if (worktreeId !== undefined) selected.value[worktreeId] = summary.id
    track("terminal_created", { scope: worktreeId !== undefined ? "worktree" : "machine" })
    return summary
  }

  /** Reopening a panel during startup shares its first shell instead of creating another. */
  function ensureWorktreeTerminal(worktreeId: string): Promise<TerminalSummary> {
    const pending = opening.get(worktreeId)
    if (pending) return pending
    const operation = (async () => {
      await refresh()
      if (error.value) throw new Error(error.value)
      return sessions.value.find(terminal => terminal.worktreeId === worktreeId && terminal.kind !== "acp") ?? create({ worktreeId })
    })().finally(() => { opening.delete(worktreeId) })
    opening.set(worktreeId, operation)
    return operation
  }

  function attach(sessionId: string, listener: TerminalListener) {
    const active = connection(sessionId)
    const attachment = Symbol(sessionId)
    attachments.set(sessionId, attachment)
    const unsubscribe = active.subscribe(sessionId, listener)
    let detached = false
    const rememberAttachment = (summary: TerminalSummary) => {
      const observed = sessions.value.find(terminal => terminal.id === sessionId)
      // A short command can exit while the attachment response is in flight.
      return remember(summary.status === "running" && observed && observed.status !== "running" ? observed : summary)
    }
    const ready = platformClient.terminal.dial({ mode: "resume", terminalId: sessionId }).then(async summary => {
      if (detached) throw new Error("Terminal attachment was cancelled")
      // Register before subscribing on the daemon so an early exit has a target.
      rememberAttachment(summary)
      const attached = await active.call("attach", { sessionId })
      if (detached) {
        if (!attachments.has(sessionId) && (streams.get(sessionId) === active || active === client)) await active.call("detach", { sessionId })
        throw new Error("Terminal attachment was cancelled")
      }
      return rememberAttachment(attached)
    })
    return { ready, detach: () => {
      if (detached) return
      detached = true; unsubscribe()
      if (attachments.get(sessionId) !== attachment) return
      attachments.delete(sessionId)
      if (streams.get(sessionId) === active) { streams.delete(sessionId); active.close(); delete streamStates.value[sessionId] }
    } }
  }

  const input = (sessionId: string, data: string) => connection(sessionId).input(sessionId, data)
  const resize = (sessionId: string, cols: number, rows: number) => connection(sessionId).call("resize", { sessionId, cols, rows })
  async function hangup(sessionId: string): Promise<void> {
    await platformClient.terminal.hangup(sessionId)
    forget(sessionId)
    delete titles.value[sessionId]
  }

  function closeTransport(): void {
    client?.close(); client = null
    for (const stream of streams.values()) stream.close()
    streams.clear()
    streamStates.value = {}
    attachments.clear()
  }
  onScopeDispose(() => { unsubscribe(); closeTransport() })
  return { sessions, loaded, state, error, relayDeniedReason, selected, titles, transportStatus, refresh, create, ensureWorktreeTerminal, attach, input, resize, hangup, closeTransport }
})
