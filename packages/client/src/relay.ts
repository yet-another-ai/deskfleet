/** Reason recorded when the server issued this peer grant; direct ICE remains available. */
export type RelayDeniedReason = "free_plan" | "turn_quota_exhausted"

export function relayFailureMessage(reason?: RelayDeniedReason | null): string | undefined {
  if (reason === "free_plan") return "Direct connection failed. The Free plan does not include TURN relay. Upgrade the Team or try a network that supports direct connections."
  if (reason === "turn_quota_exhausted") return "Direct connection failed. This Team has used its monthly TURN relay allowance. Try a network that supports direct connections or wait for the monthly reset."
  return undefined
}
