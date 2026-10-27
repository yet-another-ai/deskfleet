// Client view models for the resource catalog.

import type { AgentSessionContext } from "../../../../apps/daemon/src/agent-protocol.ts"

export interface AgentSessionSummary {
  id: string
  title?: string
  /** The agent provider's user-facing name. */
  provider?: string
  /** True only after a provider snapshot confirms that the saved provider is absent. */
  providerUnavailable?: boolean
  providerIcon?: string
  providerTemplate?: string
  /** Absent until the Session's Agent metadata has loaded. */
  archiveState?: "active" | "archiving" | "archived"
  context?: AgentSessionContext
  /** Absent while provisioning or if context creation failed. */
  worktree?: WorktreeSummary
}

/** A terminal owned by a machine, workspace, or worktree. Its cwd can change freely. */
export interface TerminalSessionSummary {
  id: string
  title: string
  cwd: string
  kind?: "acp"
}

export type GitChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked"

export interface GitChange {
  /** Relative to the checkout root. */
  path: string
  status: GitChangeStatus
  additions: number
  deletions: number
}

/** Read-only state of the checkout a directory resolves to. */
export interface GitCheckoutSummary {
  branch: string
  /** Abbreviated HEAD commit. */
  head: string
  changes: GitChange[]
}

/** An ordered path on the owning machine; the first path is the default. */
export interface DirectoryBinding {
  path: string
  /** Undefined until inspected; null when the directory is not inside a Git checkout. */
  git?: GitCheckoutSummary | null
}

/** The execution context owned by one Session. */
export interface WorktreeSummary {
  id: string
  directories: DirectoryBinding[]
  terminals: TerminalSessionSummary[]
}

export interface WorkspaceSummary {
  id: string
  name: string
  directories: DirectoryBinding[]
  sessions: AgentSessionSummary[]
  terminals: TerminalSessionSummary[]
}

export interface MachineSummary {
  id: string
  name: string
  /** Whether this is the machine running the desktop client. */
  local: boolean
  online: boolean
  /** When the catalog last observed the machine; shown while it is offline. */
  lastSeen?: string
  /** Whether the machine has a graphical session to share; headless machines do not. */
  desktop: boolean
  terminals: TerminalSessionSummary[]
  /** Sessions started without a Workspace, scoped to this machine. */
  sessions: AgentSessionSummary[]
  workspaces: WorkspaceSummary[]
}
