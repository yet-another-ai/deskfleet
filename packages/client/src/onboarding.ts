import type { DesktopPermissionsState } from "./local-agent.ts"

export const ONBOARDING_CHANNEL = "deskfleet:onboarding"
export const ONBOARDING_PERMISSIONS = ["fullDiskAccess", "screenCapture", "accessibility"] as const
export type OnboardingPermission = typeof ONBOARDING_PERMISSIONS[number]
export type OnboardingStep = "server" | OnboardingPermission | "account" | "complete"
export interface OnboardingState { step: OnboardingStep }

/** First-run setup is owned by the desktop host; OS access remains owned by its daemon. */
export interface OnboardingApi {
  get(): Promise<OnboardingState>
  saveServer(serverUrl: string): Promise<OnboardingState>
  permissions(): Promise<DesktopPermissionsState>
  requestPermission(permission: OnboardingPermission): Promise<DesktopPermissionsState>
  advancePermission(permission: OnboardingPermission): Promise<OnboardingState>
  complete(): Promise<OnboardingState>
}
