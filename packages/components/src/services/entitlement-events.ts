export type ActionOutcome = "attempt" | "success" | "failure"
export type TurnAllowanceState = "near_limit" | "reached" | "blocked"
export interface SessionCapacityDetails {
  context?: "worktree" | "directory"
  scope?: "workspace" | "machine"
}

/** Functional entitlement usage; failures do not imply a quota rejection. */
export interface EntitlementAnalyticsEvents {
  session_capacity_action: SessionCapacityDetails & { action: "create" | "fork" | "restore"; outcome: ActionOutcome }
  input_submit_action: { outcome: ActionOutcome; delivery: "backlog" | "steer" }
  member_invite_action: { outcome: ActionOutcome; invited_role: "admin" | "member" }
  team_join_action: { outcome: ActionOutcome }
  session_turn_allowance_viewed: { state: TurnAllowanceState; used_turns: number; turn_limit?: number }
  session_turn_plans_clicked: { source: TurnAllowanceState }
}
