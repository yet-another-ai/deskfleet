import type { DesktopPermission, DesktopPermissionsState } from "./control-protocol.ts"

/** Desktop permissions belong to the daemon process that captures and controls the desktop. */
export class DesktopPermissions {
  #state: DesktopPermissionsState = {
    screenCapturePermission: { status: "requesting" },
    accessibilityPermission: { status: "requesting" },
  }
  #requested = false
  readonly #listeners = new Set<(permissions: DesktopPermissionsState) => void>()

  get state(): DesktopPermissionsState {
    return {
      screenCapturePermission: { ...this.#state.screenCapturePermission },
      accessibilityPermission: { ...this.#state.accessibilityPermission },
    }
  }

  onChange(listener: (permissions: DesktopPermissionsState) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  request(access: {
    requestScreenCaptureAccess: () => Promise<boolean | null>
    requestAccessibilityAccess: () => Promise<boolean | null>
  }): void {
    if (this.#requested) return
    this.#requested = true
    // Requests settle independently. Neither a pending system dialog nor a denied
    // permission holds up IPC readiness, the other request, or daemon shutdown.
    this.#request("screenCapturePermission", access.requestScreenCaptureAccess)
    this.#request("accessibilityPermission", access.requestAccessibilityAccess)
  }

  #request(key: keyof DesktopPermissionsState, requestAccess: () => Promise<boolean | null>): void {
    void Promise.resolve().then(requestAccess).then(
      granted => this.#update(key, { status: granted === null ? "not-required" : granted ? "granted" : "denied" }),
      error => this.#update(key, { status: "error", error: error instanceof Error ? error.message : String(error) }),
    )
  }

  #update(key: keyof DesktopPermissionsState, permission: DesktopPermission): void {
    this.#state[key] = permission
    for (const listener of this.#listeners) listener(this.state)
  }
}
