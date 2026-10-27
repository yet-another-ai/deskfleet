/** Reason recorded when the server issued this peer grant; direct ICE remains available. */
export type RelayDeniedReason = "free_plan" | "turn_quota_exhausted" | "metering_unavailable"

export function relayFailureMessage(reason?: RelayDeniedReason | null): string | undefined {
  if (reason === "free_plan") return "Direct connection failed. The Free plan does not include TURN relay. Upgrade the Team or try a network that supports direct connections."
  if (reason === "turn_quota_exhausted") return "Direct connection failed. This Team has used its monthly TURN relay allowance. Try a network that supports direct connections or wait for the monthly reset."
  if (reason === "metering_unavailable") return "Direct connection failed. TURN relay is temporarily unavailable because usage metering is not up to date. Try again later or use a network that supports direct connections."
  return undefined
}
