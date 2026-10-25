import { client as platformClient } from "@deskfleet/client/platform"
import { defineStore } from "pinia"
import { onScopeDispose, ref } from "vue"
import type { TerminalSummary } from "../../../../apps/daemon/src/terminal-protocol.ts"
import { TerminalClient, type TerminalConnectionState, type TerminalListener } from "../services/terminal-client.ts"

/** Shell lifecycle uses signaling; the shared data-only peer carries terminal I/O. */
export const useTerminalsStore = defineStore("terminals", () => {
  const sessions = ref<TerminalSummary[]>([])
  const state = ref<TerminalConnectionState>("idle")
  const error = ref<string | null>(null)
  /** The tab last shown in each Session Worktree's terminal panel. */
  const selected = ref<Record<string, string>>({})
  /** The title each shell's running program last reported; replay restores it after reattaching. */
  const titles = ref<Record<string, string>>({})
  let client: TerminalClient | null = null
  let refreshing: Promise<void> | null = null
  let refreshChanges: Map<string, TerminalSummary | null> | null = null
  const opening = new Map<string, Promise<TerminalSummary>>()
  const unsubscribe = platformClient.terminal.onSessionEvent((event) => {
    if (event.kind === "terminalChanged") remember(event.terminal)
    else forget(event.terminalId)
  })

  function connection(): TerminalClient {
    client ??= new TerminalClient(platformClient.terminal, (next, detail) => {
      state.value = next
      error.value = detail ?? null
    }, (event) => {
      if (event.kind !== "exit") return
      const terminal = sessions.value.find(({ id }) => id === event.sessionId)
      if (terminal) remember({ ...terminal, status: "exited", exitCode: event.exitCode })
    })
    return client
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
      error.value = null
    }).catch((reason: unknown) => {
      error.value = reason instanceof Error ? reason.message : String(reason)
    }).finally(() => { refreshing = null; refreshChanges = null })
    return refreshing
  }

  /** A `worktreeId` makes the terminal its Session's; without `cwd` it starts in the Worktree's first directory. */
  async function create(options: { cwd?: string; worktreeId?: string; cols?: number; rows?: number } = {}): Promise<TerminalSummary> {
    error.value = null
    const { cols = 80, rows = 24, cwd, worktreeId } = options
    const summary = remember(await platformClient.terminal.dial({
      mode: "create", terminalId: crypto.randomUUID(), cols, rows,
      ...(cwd === undefined ? {} : { cwd }), ...(worktreeId === undefined ? {} : { worktreeId }),
    }))
    if (worktreeId !== undefined) selected.value[worktreeId] = summary.id
    return summary
  }

  /** Reopening a panel during startup shares its first shell instead of creating another. */
  function ensureWorktreeTerminal(worktreeId: string): Promise<TerminalSummary> {
    const pending = opening.get(worktreeId)
    if (pending) return pending
    const operation = (async () => {
      await refresh()
      if (error.value) throw new Error(error.value)
      return sessions.value.find(terminal => terminal.worktreeId === worktreeId) ?? create({ worktreeId })
    })().finally(() => { opening.delete(worktreeId) })
    opening.set(worktreeId, operation)
    return operation
  }

  function attach(sessionId: string, listener: TerminalListener) {
    const active = connection()
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
        await active.call("detach", { sessionId })
        throw new Error("Terminal attachment was cancelled")
      }
      return rememberAttachment(attached)
    })
    return { ready, detach: () => { detached = true; unsubscribe() } }
  }

  const input = (sessionId: string, data: string) => connection().input(sessionId, data)
  const resize = (sessionId: string, cols: number, rows: number) => connection().call("resize", { sessionId, cols, rows })
  async function hangup(sessionId: string): Promise<void> {
    await platformClient.terminal.hangup(sessionId)
    forget(sessionId)
    delete titles.value[sessionId]
  }

  onScopeDispose(() => { unsubscribe(); client?.close() })
  return { sessions, state, error, selected, titles, refresh, create, ensureWorktreeTerminal, attach, input, resize, hangup }
})
