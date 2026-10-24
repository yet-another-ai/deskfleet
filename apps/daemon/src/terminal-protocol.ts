/** Terminal I/O uses a reliable, ordered WebRTC DataChannel. */
export const TERMINAL_CHANNEL = "deskfleet-terminal"
export const TERMINAL_CHUNK_BYTES = 8 * 1024
export const MAX_TERMINAL_MESSAGE_BYTES = 32 * 1024

export interface TerminalSummary {
  id: string
  title: string
  cwd: string
  cols: number
  rows: number
  status: "running" | "exited" | "interrupted"
  exitCode?: number
  /** The Session Worktree that owns this terminal; absent for machine terminals. */
  worktreeId?: string
}

/** Shell lifecycle belongs to authenticated signaling, independently of its data peer. */
export type TerminalDial =
  /** A Worktree terminal defaults to the Worktree's first directory and ends with its Session. */
  | { mode: "create"; terminalId: string; cols: number; rows: number; cwd?: string; worktreeId?: string }
  | { mode: "resume"; terminalId: string }

export type TerminalSessionEvent =
  | { kind: "terminalChanged"; terminal: TerminalSummary }
  | { kind: "terminalHungup"; terminalId: string }

export interface TerminalMethods {
  attach: { params: { sessionId: string }; result: TerminalSummary }
  detach: { params: { sessionId: string }; result: null }
  input: { params: { sessionId: string; data: string }; result: null }
  resize: { params: { sessionId: string; cols: number; rows: number }; result: null }
}

export type TerminalRequest = {
  [M in keyof TerminalMethods]: { id: number; method: M; params: TerminalMethods[M]["params"] }
}[keyof TerminalMethods]

export type TerminalEvent =
  | { kind: "reset"; sessionId: string }
  | { kind: "ready"; sessionId: string }
  | { kind: "hungup"; sessionId: string }
  /** Base64 preserves UTF-8 split across PTY reads. Acknowledge after xterm consumes it. */
  | { kind: "output"; sessionId: string; data: string; offset: number }
  | { kind: "exit"; sessionId: string; exitCode?: number }
  | { kind: "error"; sessionId: string; error: string }

export type TerminalMessage =
  | { id: number; result: unknown; error?: never }
  | { id: number; error: string; result?: never }
  | { event: TerminalEvent }

export interface TerminalAck {
  ack: { sessionId: string; offset: number }
}
