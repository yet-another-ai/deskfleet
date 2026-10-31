import type { ScheduledTask } from "./schedules.ts"

export type SearchKind = "all" | "chat" | "schedule"
export interface SearchQuery {
  q: string
  kind?: SearchKind
  cursor?: string
  limit?: number
}

interface SearchLocation {
  machineId: string
  machineName: string
  workspaceId?: string
  workspaceName?: string
  resourceId: string
  title: string
  snippet: string
  updatedAt: string
}

/** Resource identity is qualified by Machine; chat hits retain their conversation anchor. */
export type SearchResult = SearchLocation & (
  | { kind: "chat"; entryId?: string }
  | { kind: "schedule"; entryId?: never }
)
export interface SearchPage { results: SearchResult[]; nextCursor?: string }
export interface ScheduleSnapshot { tasks: ScheduledTask[]; lastObservedAt: string | null }
