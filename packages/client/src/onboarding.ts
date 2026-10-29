import type { DesktopPermissionsState } from "./local-agent.ts"

export const ONBOARDING_CHANNEL = "deskfleet:onboarding"
export const ONBOARDING_PERMISSIONS = ["fullDiskAccess", "screenCapture", "accessibility"] as const
export type OnboardingPermission = typeof ONBOARDING_PERMISSIONS[number]
export type OnboardingStep = OnboardingPermission | "account" | "complete"
export interface OnboardingState {
  step: OnboardingStep
  linuxDesktopBackend?: DesktopPermissionsState["linuxDesktopBackend"]
}

/** Permission guidance follows the desktop host's platform. Linux Portal consent is Wayland-only. */
export function onboardingPermissions(platform: string, backend?: DesktopPermissionsState["linuxDesktopBackend"]): readonly OnboardingPermission[] {
  if (platform === "darwin") return ONBOARDING_PERMISSIONS
  if (platform === "linux" && backend === "wayland") return ["screenCapture", "accessibility"]
  return []
}

/** First-run setup is owned by the desktop host; OS access remains owned by its daemon. */
export interface OnboardingApi {
  get(): Promise<OnboardingState>
  permissions(): Promise<DesktopPermissionsState>
  requestPermission(permission: OnboardingPermission): Promise<DesktopPermissionsState>
  advancePermission(permission: OnboardingPermission): Promise<OnboardingState>
  complete(): Promise<OnboardingState>
}
