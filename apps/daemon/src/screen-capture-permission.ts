import type { ScreenCapturePermission } from "./control-protocol.ts"

/** Permission belongs to the process that will capture the desktop. */
export class ScreenCapturePermissions {
  #state: ScreenCapturePermission = { status: "requesting" }
  readonly #listeners = new Set<(permission: ScreenCapturePermission) => void>()

  get state(): ScreenCapturePermission { return { ...this.#state } }

  onChange(listener: (permission: ScreenCapturePermission) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  request(requestAccess: () => Promise<boolean | null>): void {
    // A system dialog must not hold up IPC readiness, terminals, or shutdown.
    void Promise.resolve().then(requestAccess).then(
      granted => this.#update({ status: granted === null ? "not-required" : granted ? "granted" : "denied" }),
      error => this.#update({ status: "error", error: error instanceof Error ? error.message : String(error) }),
    )
  }

  #update(permission: ScreenCapturePermission): void {
    this.#state = permission
    for (const listener of this.#listeners) listener(this.state)
  }
}
