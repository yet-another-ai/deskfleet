import type { DesktopPermissionsState } from "./local-agent.ts"
import type { WindowsDesktopServiceState } from "./windows-desktop-service.ts"

export const ONBOARDING_CHANNEL = "deskfleet:onboarding"
export const DESKTOP_ONBOARDING_PERMISSIONS = ["fullDiskAccess", "screenCapture", "accessibility"] as const
const MACOS_ONBOARDING_PERMISSIONS = ["localNetwork", ...DESKTOP_ONBOARDING_PERMISSIONS] as const
export const ONBOARDING_PERMISSIONS = [...MACOS_ONBOARDING_PERMISSIONS, "windowsDesktopService", "auv"] as const
export type OnboardingPermission = typeof ONBOARDING_PERMISSIONS[number]
export type OnboardingStep = OnboardingPermission | "account" | "complete"
export interface OnboardingState {
  step: OnboardingStep
  permissionSteps: readonly OnboardingPermission[]
  linuxDesktopBackend?: DesktopPermissionsState["linuxDesktopBackend"]
}

/** macOS cannot report a permission decision; an attempted request is not a grant. */
export type LocalNetworkAccessRequest = "attempted" | "unavailable" | "not-required"
/** Saved AUV restore tokens can be reused; their presence does not prove a current OS grant. */
export interface AuvPermissionsState {
  status: "not-requested" | "requesting" | "saved" | "error"
  error?: string
}
export interface OnboardingPermissionsState extends Partial<DesktopPermissionsState> {
  localNetwork?: "not-requested" | LocalNetworkAccessRequest
  windowsDesktopService?: WindowsDesktopServiceState
  auv?: AuvPermissionsState
}

/** AUV owns separate Portal grants; the daemon's X11 backend does not grant AUV access. */
export function onboardingPermissions(platform: string, backend?: DesktopPermissionsState["linuxDesktopBackend"], localAgent = true): readonly OnboardingPermission[] {
  if (platform === "darwin") return localAgent ? MACOS_ONBOARDING_PERMISSIONS : ["localNetwork"]
  if (!localAgent) return []
  if (platform === "win32") return ["windowsDesktopService"]
  if (platform === "linux") return backend === "wayland" ? ["screenCapture", "accessibility", "auv"] : ["auv"]
  return []
}

/** The host owns setup, AUV, service installation, and client network access; the daemon owns its native permissions. */
export interface OnboardingApi {
  get(): Promise<OnboardingState>
  /** Silent checks for the active welcome step, or all applicable permissions after setup. */
  permissions(): Promise<OnboardingPermissionsState>
  /** Completed setup allows revisiting any applicable permission without changing progress. */
  requestPermission(permission: OnboardingPermission): Promise<OnboardingPermissionsState>
  openLocalNetworkSettings(): Promise<void>
  advancePermission(permission: OnboardingPermission): Promise<OnboardingState>
  complete(): Promise<OnboardingState>
}
