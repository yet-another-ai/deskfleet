import { DESKTOP_PERMISSION_KINDS, type DesktopPermission, type DesktopPermissionKind, type DesktopPermissionsState } from "./control-protocol.ts"

export type PermissionAccess = Record<DesktopPermissionKind, () => Promise<boolean | null>>

/** OS permissions belong to the daemon process that accesses files and controls the desktop. */
export class DesktopPermissions {
  // "checking" is a silent read. "requesting" means a system prompt is open.
  #state: DesktopPermissionsState = {
    screenCapturePermission: { status: "checking" },
    accessibilityPermission: { status: "checking" },
    fullDiskAccessPermission: { status: "checking" },
  }
  #requests?: PermissionAccess
  #checks?: PermissionAccess
  #refresh?: Promise<DesktopPermissionsState>
  readonly #pending = new Map<DesktopPermissionKind, Promise<void>>()
  readonly #revisions = { fullDiskAccess: 0, screenCapture: 0, accessibility: 0 }
  readonly #listeners = new Set<(permissions: DesktopPermissionsState) => void>()

  get state(): DesktopPermissionsState {
    return {
      screenCapturePermission: { ...this.#state.screenCapturePermission },
      accessibilityPermission: { ...this.#state.accessibilityPermission },
      fullDiskAccessPermission: { ...this.#state.fullDiskAccessPermission },
    }
  }

  onChange(listener: (permissions: DesktopPermissionsState) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  initialize(requests: PermissionAccess, checks: PermissionAccess, mode: "automatic" | "guided" = "automatic"): void {
    if (this.#requests) return
    this.#requests = requests
    this.#checks = checks
    // A hosted daemon checks silently. Its welcome flow requests each permission
    // explicitly; standalone startup retains automatic requests without blocking IPC.
    if (mode === "guided") void this.refresh()
    else for (const kind of DESKTOP_PERMISSION_KINDS) this.requestPermission(kind)
  }

  requestPermission(kind: DesktopPermissionKind): DesktopPermissionsState {
    if (!this.#requests) throw new Error("Daemon permissions are not initialized")
    if (this.#pending.has(kind)) return this.state
    ++this.#revisions[kind]
    if (this.#state[`${kind}Permission`].status !== "requesting") this.#update(kind, { status: "requesting" })
    const request = this.#requests[kind]
    const pending = this.#read(request).then(permission => this.#update(kind, permission))
      .finally(() => { this.#pending.delete(kind) })
    this.#pending.set(kind, pending)
    // A system dialog must not hold up IPC, welcome navigation, or daemon shutdown.
    return this.state
  }

  refresh(): Promise<DesktopPermissionsState> {
    if (!this.#checks) return Promise.reject(new Error("Daemon permissions are not initialized"))
    this.#refresh ??= Promise.all(DESKTOP_PERMISSION_KINDS.map(async kind => {
      if (this.#pending.has(kind)) return
      const revision = this.#revisions[kind]
      const permission = await this.#read(this.#checks![kind])
      // A focus-triggered check must not overwrite a newer request's result.
      if (revision === this.#revisions[kind]) this.#update(kind, permission)
    })).then(() => this.state).finally(() => { this.#refresh = undefined })
    return this.#refresh
  }

  async #read(access: () => Promise<boolean | null>): Promise<DesktopPermission> {
    try {
      const granted = await Promise.resolve().then(access)
      return { status: granted === null ? "not-required" : granted ? "granted" : "denied" }
    } catch (error) { return { status: "error", error: error instanceof Error ? error.message : String(error) } }
  }

  #update(kind: DesktopPermissionKind, permission: DesktopPermission): void {
    this.#state[`${kind}Permission`] = permission
    for (const listener of this.#listeners) listener(this.state)
  }
}
