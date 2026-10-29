import type { LinuxDesktopBackend } from "./control-protocol.ts"
import type { PermissionAccess } from "./desktop-permissions.ts"

export interface LinuxDesktopAccess {
  screenCapture: boolean
  control: boolean
}

export interface LinuxDesktopPermissionApi {
  request(directory: string): Promise<LinuxDesktopAccess>
  check(): Promise<LinuxDesktopAccess>
  close(): Promise<void>
  /** Fires when the shared grant changes without a new request. */
  subscribe?(listener: () => void): () => void
}

/** Linux access uses one Portal session on Wayland and silent connection checks on X11. */
export class LinuxDesktopPermissions {
  readonly requests: PermissionAccess
  readonly checks: PermissionAccess
  readonly #native: LinuxDesktopPermissionApi
  readonly #backend: LinuxDesktopBackend
  #request?: Promise<LinuxDesktopAccess>
  #check?: Promise<LinuxDesktopAccess>
  #closing?: Promise<void>
  #stopWatch?: () => void

  constructor(directory: string, native: LinuxDesktopPermissionApi, backend: LinuxDesktopBackend = "wayland") {
    this.#native = native
    this.#backend = backend
    const request = () => {
      if (this.#closing) return Promise.reject(new Error("Linux desktop access is closing"))
      return this.#request ??= Promise.resolve().then(() => {
        if (this.#closing) throw new Error("Linux desktop access is closing")
        return backend === "wayland" ? native.request(directory) : native.check()
      })
        .finally(() => { this.#request = undefined })
    }
    const check = () => {
      if (this.#closing) return Promise.resolve({ screenCapture: false, control: false })
      return this.#check ??= Promise.resolve().then(() => native.check())
        .finally(() => { this.#check = undefined })
    }
    const access = (granted: boolean) => backend === "x11" && granted ? null : granted
    this.requests = {
      screenCapture: async () => access((await request()).screenCapture),
      accessibility: async () => access((await request()).control),
      fullDiskAccess: async () => null,
    }
    this.checks = {
      screenCapture: async () => access((await check()).screenCapture),
      accessibility: async () => access((await check()).control),
      fullDiskAccess: async () => null,
    }
  }

  /** Refreshes daemon permissions when capture stays up and remote input drops. */
  onAccessChanged(listener: () => void): void {
    this.#stopWatch?.()
    this.#stopWatch = this.#backend === "wayland" ? this.#native.subscribe?.(listener) : undefined
  }

  /** Cancels a pending dialog without awaiting its response. */
  close(): Promise<void> {
    return this.#closing ??= (async () => {
      this.#stopWatch?.()
      this.#stopWatch = undefined
      await this.#native.close()
    })()
  }
}
