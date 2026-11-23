import type { AgentAuthStatus } from "./agents/core.ts"

export type { AgentAuthStatus }

export interface AgentLiveNotice {
  id: string
  severity: string
  title: string
  description?: string
  providerSessionId?: string
}

/** Provider status is transient and never becomes synchronized conversation history. */
export type AgentLiveUpdate = {
  sessionId: string
  runGeneration: number
} & (
  | { kind: "notice"; notice: AgentLiveNotice }
  | { kind: "auth"; auth: AgentAuthStatus | null }
)
