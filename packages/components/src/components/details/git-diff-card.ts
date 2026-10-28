import type { GitChangeKind, GitDiffRequest, GitFileDiff } from "../../../../../apps/daemon/src/git-protocol.ts"

export interface GitDiffCard {
  request: GitDiffRequest
  diff: GitFileDiff | null
  loading: boolean
  error: string | null
}

/** Stable identity for one file on one side of the index. */
export function gitDiffCardKey(repositoryId: string, path: string, kind: GitChangeKind): string {
  return `${repositoryId}\0${kind}\0${path}`
}
