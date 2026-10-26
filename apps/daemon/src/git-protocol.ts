/** Live Git inspection is transient and scoped to a Session's captured directories. */
export type GitChangeKind = "staged" | "unstaged" | "untracked"
export type GitFileStatus = "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted" | "typeChanged"

export interface GitFileChange {
  path: string
  previousPath?: string
  kind: GitChangeKind
  status: GitFileStatus
  /** Null for binary files or unavailable counts. */
  additions: number | null
  deletions: number | null
}

export interface GitRepositoryStatus {
  id: string
  root: string
  branch: string | null
  head: string | null
  changes: GitFileChange[]
  error?: string
}

export interface GitStatusSnapshot {
  sessionId: string
  repositories: GitRepositoryStatus[]
  /** Multiple bindings may refer to one checkout. Null means a non-Git directory. */
  directories: { path: string; repositoryId: string | null; error?: string }[]
}

export interface GitChangedNotification {
  sessionId: string
  subscriptionId: string
  error?: string
}

export interface GitDiffRequest {
  sessionId: string
  repositoryId: string
  path: string
  kind: GitChangeKind
}

export interface GitFileDiff extends GitDiffRequest {
  patch: string
  binary: boolean
  truncated: boolean
}
