import type { DesktopPermissionsState } from "./local-agent.ts"

export const ONBOARDING_CHANNEL = "deskfleet:onboarding"
export const DESKTOP_ONBOARDING_PERMISSIONS = ["fullDiskAccess", "screenCapture", "accessibility"] as const
export const ONBOARDING_PERMISSIONS = ["localNetwork", ...DESKTOP_ONBOARDING_PERMISSIONS] as const
export type OnboardingPermission = typeof ONBOARDING_PERMISSIONS[number]
export type OnboardingStep = OnboardingPermission | "account" | "complete"
export interface OnboardingState {
  step: OnboardingStep
  permissionSteps: readonly OnboardingPermission[]
  linuxDesktopBackend?: DesktopPermissionsState["linuxDesktopBackend"]
}

/** macOS cannot report a permission decision; an attempted request is not a grant. */
export type LocalNetworkAccessRequest = "attempted" | "unavailable" | "not-required"
export interface OnboardingPermissionsState extends Partial<DesktopPermissionsState> {
  localNetwork?: "not-requested" | LocalNetworkAccessRequest
}

/** Permission guidance follows the desktop host's platform. Linux Portal consent is Wayland-only. */
export function onboardingPermissions(platform: string, backend?: DesktopPermissionsState["linuxDesktopBackend"], localAgent = true): readonly OnboardingPermission[] {
  if (platform === "darwin") return localAgent ? ONBOARDING_PERMISSIONS : ["localNetwork"]
  if (!localAgent) return []
  if (platform === "linux" && backend === "wayland") return ["screenCapture", "accessibility"]
  return []
}

/** The desktop host owns setup and client network access; the daemon owns capture/file/input access. */
export interface OnboardingApi {
  get(): Promise<OnboardingState>
  permissions(): Promise<OnboardingPermissionsState>
  requestPermission(permission: OnboardingPermission): Promise<OnboardingPermissionsState>
  openLocalNetworkSettings(): Promise<void>
  advancePermission(permission: OnboardingPermission): Promise<OnboardingState>
  complete(): Promise<OnboardingState>
}
