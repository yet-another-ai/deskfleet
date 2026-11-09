/** Provider status is transient and never becomes synchronized conversation history. */
export interface AgentAuthStatus {
  kind: "account" | "api_key" | "gateway" | "external" | "none"
  label: string
  detail?: string
  account?: { email?: string; organization?: string; plan?: string }
}

export interface AgentLiveNotice {
  id: string
  severity: string
  title: string
  description?: string
  providerSessionId?: string
}

export type AgentLiveUpdate = {
  sessionId: string
  runGeneration: number
} & (
  | { kind: "notice"; notice: AgentLiveNotice }
  | { kind: "auth"; auth: AgentAuthStatus | null }
)
