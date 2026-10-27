import { homedir } from "node:os"
import { basename, isAbsolute } from "node:path"
import { createTerminal, type NativeTerminal, type TerminalConfig } from "@deskfleet/native"
import { TerminalHistory } from "./terminal-history.ts"
import type { TerminalDial, TerminalSessionEvent, TerminalSummary } from "./terminal-protocol.ts"

export type TerminalFactory = (config: TerminalConfig) => Promise<NativeTerminal>
export type TerminalChange = "output" | "state" | "hangup"

/** Only daemon-owned operations select a program; the public dial API starts shells. */
export interface TerminalRun {
  terminalId: string
  title: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  cols: number
  rows: number
  worktreeId?: string
  kind?: "acp"
}

interface Session {
  summary: TerminalSummary
  history: TerminalHistory
  native?: NativeTerminal
  error?: string
  listeners: Set<(change: TerminalChange) => void>
  controller?: object
  drained: Promise<void>
  stopping?: Promise<void>
  stopRequested: boolean
  hangingUp?: Promise<void>
}

export interface TerminalSnapshot {
  summary: TerminalSummary
  end: number
  error?: string
}

export function terminalSize(cols: unknown, rows: unknown): void {
  for (const value of [cols, rows]) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1000) {
      throw new Error("Terminal dimensions must be integers between 1 and 1000")
    }
  }
}

function sessionId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) throw new Error("Invalid terminal session ID")
}

/** PTYs and transcripts belong to the daemon independently of their viewers. */
export class TerminalSessions {
  readonly #directory: string
  readonly #factory: TerminalFactory
  readonly #sessions = new Map<string, Session>()
  readonly #spawning = new Map<string, Promise<TerminalSummary>>()
  readonly #listeners = new Set<(event: TerminalSessionEvent) => void>()
  #initializing: Promise<void> | undefined
  #closed = false
  #closing: Promise<void> | undefined

  constructor(options: { directory: string; factory?: TerminalFactory }) {
    this.#directory = options.directory
    this.#factory = options.factory ?? createTerminal
  }

  init(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Terminal sessions are closed"))
    return this.#initializing ??= (async () => {
      const histories = await TerminalHistory.recover(this.#directory)
      try {
        for (const history of histories) {
          const summary = history.terminal
          if (summary.status === "running") {
            summary.status = "interrupted"
            await history.save(summary, history.error)
          }
          this.#sessions.set(summary.id, {
            summary, history, error: history.error, listeners: new Set(), drained: Promise.resolve(), stopRequested: false,
          })
        }
      } catch (error) {
        this.#sessions.clear()
        await Promise.allSettled(histories.map(history => history.close()))
        throw error
      }
    })()
  }

  list(): TerminalSummary[] {
    return [...this.#sessions.values()].map(session => ({ ...session.summary }))
  }

  onChange(listener: (event: TerminalSessionEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async dial(options: TerminalDial): Promise<TerminalSummary> {
    if (options.mode === "create") return this.#create({
      terminalId: options.terminalId, cols: options.cols, rows: options.rows,
      cwd: options.cwd, worktreeId: options.worktreeId,
    })
    if (this.#closed) throw new Error("Terminal sessions are closed")
    await this.init()
    if (this.#closed) throw new Error("Terminal sessions are closed")
    sessionId(options.terminalId)
    const pending = this.#spawning.get(options.terminalId)
    if (pending) await pending
    return { ...this.#session(options.terminalId).summary }
  }

  /** Run a setup or Agent command with shared history and exit events. */
  async run(options: TerminalRun): Promise<TerminalSummary> {
    if (!options.command || options.command.includes("\0")) throw new Error("Invalid terminal command")
    if (options.args?.some(argument => argument.includes("\0"))) throw new Error("Invalid terminal argument")
    for (const [key, value] of Object.entries(options.env ?? {})) {
      // Inherited OS variables include names such as Windows ProgramFiles(x86).
      // User-authored provider overrides are validated separately at their RPC boundary.
      if (!key || key.includes("=") || key.includes("\0") || value.includes("\0")) throw new Error("Invalid terminal environment")
    }
    return this.#create({ ...options, args: options.args?.slice(), env: options.env ? { ...options.env } : undefined })
  }

  async #create(options: {
    terminalId: string; cols: number; rows: number; cwd?: string; worktreeId?: string
    title?: string; command?: string; args?: string[]; env?: Record<string, string>; kind?: "acp"
  }): Promise<TerminalSummary> {
    if (this.#closed) throw new Error("Terminal sessions are closed")
    await this.init()
    if (this.#closed) throw new Error("Terminal sessions are closed")
    sessionId(options.terminalId)
    const existing = this.#sessions.get(options.terminalId)
    if (existing) return { ...existing.summary }
    const pending = this.#spawning.get(options.terminalId)
    if (pending) return pending
    terminalSize(options.cols, options.rows)
    const cwd = options.cwd ?? homedir()
    if (!cwd || !isAbsolute(cwd) || cwd.includes("\0")) throw new Error("Terminal working directory must be an absolute path")
    const config: TerminalConfig = { cwd, cols: options.cols, rows: options.rows }
    if (options.command !== undefined) {
      config.command = options.command
      config.args = options.args
      config.env = options.env
    }
    const spawning = this.#spawn(options.terminalId, config, options.worktreeId, options.title, options.kind)
    this.#spawning.set(options.terminalId, spawning)
    try { return await spawning }
    finally { this.#spawning.delete(options.terminalId) }
  }

  async #spawn(id: string, config: TerminalConfig, worktreeId?: string, title?: string, kind?: "acp"): Promise<TerminalSummary> {
    const { cwd, cols, rows } = config
    const summary: TerminalSummary = { id, title: title || basename(cwd) || cwd, cwd, cols, rows, status: "running", ...(worktreeId ? { worktreeId } : {}), ...(kind ? { kind } : {}) }
    const history = await TerminalHistory.create(this.#directory, summary)
    let native: NativeTerminal
    try { native = await this.#factory(config) }
    catch (error) { await history.remove(); throw error }
    const session: Session = {
      summary, history, native, listeners: new Set(), drained: Promise.resolve(), stopRequested: false,
    }
    this.#sessions.set(id, session)
    session.drained = this.#drain(session)
    if (this.#closed) {
      await this.#stop(session)
      throw new Error("Terminal sessions are closed")
    }
    this.#changed(session)
    return { ...summary }
  }

  snapshot(id: string): TerminalSnapshot {
    const session = this.#session(id)
    return { summary: { ...session.summary }, end: session.history.end, error: session.error }
  }

  read(id: string, offset: number, length: number): Promise<Buffer> {
    return this.#session(id).history.read(offset, length)
  }

  /** Process completion includes draining and persisting its final output. */
  async waitForExit(id: string): Promise<void> {
    const session = this.#session(id)
    await session.drained
    await session.stopping
    if (session.error) throw new Error(session.error)
  }

  /** Agent process control retains the transcript for existing tool-call references. */
  stop(id: string): Promise<void> {
    return this.#stop(this.#session(id))
  }

  subscribe(id: string, listener: (change: TerminalChange) => void): () => void {
    const session = this.#session(id)
    session.listeners.add(listener)
    return () => session.listeners.delete(listener)
  }

  claim(id: string, controller: object): void {
    const session = this.#session(id)
    if (session.hangingUp) throw new Error("Terminal is hanging up")
    if (session.controller && session.controller !== controller) throw new Error("Terminal is already attached to another client")
    session.controller = controller
  }

  release(id: string, controller: object): void {
    const session = this.#sessions.get(id)
    if (session?.controller === controller) session.controller = undefined
  }

  async input(id: string, data: Buffer): Promise<void> {
    this.#requireInteractive(id)
    await this.#running(id).native!.write(data)
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    this.#requireInteractive(id)
    terminalSize(cols, rows)
    const session = this.#running(id)
    await session.native!.resize(cols, rows)
    session.summary.cols = cols
    session.summary.rows = rows
    await session.history.save(session.summary, session.error)
    this.#changed(session)
  }

  async hangup(id: string): Promise<void> {
    await this.init()
    await this.#spawning.get(id)
    this.#requireInteractive(id)
    return this.#hangup(id)
  }

  async #hangup(id: string): Promise<void> {
    if (this.#closed) throw new Error("Terminal sessions are closed")
    await this.init()
    const pending = this.#spawning.get(id)
    if (pending) await pending
    const session = this.#sessions.get(id)
    if (!session) return
    if (session.hangingUp) return session.hangingUp
    const hangingUp = (async () => {
      await this.#stop(session)
      // A channel releases its attachment before the history file is closed.
      for (const listener of session.listeners) listener("hangup")
      await session.history.remove()
      this.#sessions.delete(id)
      for (const listener of this.#listeners) listener({ kind: "terminalHungup", terminalId: id })
    })()
    session.hangingUp = hangingUp
    try { await hangingUp }
    catch (error) {
      if (session.hangingUp === hangingUp) session.hangingUp = undefined
      throw error
    }
  }

  /** Hangs up every terminal a Session Worktree owns, before that Worktree is removed. */
  async hangupOwned(worktreeId: string): Promise<void> {
    await this.init()
    await Promise.allSettled(this.#spawning.values())
    const owned = [...this.#sessions.values()].filter(session => session.summary.worktreeId === worktreeId)
    await Promise.all(owned.map(session => this.#hangup(session.summary.id)))
  }

  /** Stop Session-owned PTYs, retaining their final bytes, identity, and metadata. */
  async stopOwned(worktreeId: string): Promise<void> {
    if (this.#closed) throw new Error("Terminal sessions are closed")
    await this.init()
    await Promise.allSettled(this.#spawning.values())
    const owned = [...this.#sessions.values()].filter(session => session.summary.worktreeId === worktreeId)
    const results = await Promise.allSettled(owned.map(session => this.#stop(session)))
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, "Could not stop all Session terminals")
  }

  close(): Promise<void> {
    this.#closed = true
    return this.#closing ??= (async () => {
      // An uninitialized registry has not acquired ownership of persisted files.
      await this.#initializing?.catch(() => {})
      await Promise.allSettled(this.#spawning.values())
      const results = await Promise.allSettled([...this.#sessions.values()].map(async session => {
        try { await this.#stop(session) }
        finally { await session.history.close() }
      }))
      this.#sessions.clear()
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, "Failed to close terminal sessions")
    })()
  }

  #session(id: string): Session {
    const session = this.#sessions.get(id)
    if (!session) throw new Error("Unknown terminal session")
    return session
  }

  #requireInteractive(id: string): void {
    if (this.#sessions.get(id)?.summary.kind === "acp") throw new Error("ACP terminals are read-only")
  }

  #running(id: string): Session {
    const session = this.#session(id)
    if (this.#closed || session.summary.status !== "running" || !session.native || session.stopRequested) throw new Error("Terminal is not running")
    return session
  }

  #changed(session: Session): void {
    for (const listener of session.listeners) listener("state")
    for (const listener of this.#listeners) listener({ kind: "terminalChanged", terminal: { ...session.summary } })
  }

  #stop(session: Session): Promise<void> {
    if (session.stopping) return session.stopping
    const stopping = (async () => {
      if (!session.native) return
      session.stopRequested = true
      if (session.summary.status === "running") session.summary.status = "interrupted"
      await session.native?.close()
      await session.drained
      await session.history.save(session.summary, session.error)
      this.#changed(session)
    })()
    session.stopping = stopping
    void stopping.catch(() => { if (session.stopping === stopping) session.stopping = undefined })
    return stopping
  }

  async #drain(session: Session): Promise<void> {
    try {
      for (;;) {
        const event = await session.native!.nextEvent()
        if (!event) break
        if (event.kind === "data" && event.data) {
          await session.history.append(event.data)
          for (const listener of session.listeners) listener("output")
        } else if (event.kind === "exit" && (!session.stopRequested || session.summary.kind === "acp")) {
          session.summary.status = "exited"
          session.summary.exitCode = event.exitCode
          await session.history.save(session.summary, session.error)
          this.#changed(session)
        } else if (event.kind === "error") {
          throw new Error(event.error ?? "Terminal failed")
        }
      }
      if (session.summary.status === "running") throw new Error("Terminal event stream ended without an exit status")
    } catch (error) {
      session.error = error instanceof Error ? error.message : String(error)
      session.summary.status = "interrupted"
      await session.native!.close().catch(cleanup => { session.error += `; cleanup: ${String(cleanup)}` })
      await session.history.save(session.summary, session.error).catch(persistence => {
        session.error += `; history: ${String(persistence)}`
      })
      this.#changed(session)
    }
  }
}
