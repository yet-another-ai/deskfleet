import type { PermissionAccess } from "./desktop-permissions.ts"

export interface WaylandDesktopAccess {
  screenCapture: boolean
  control: boolean
}

export interface WaylandDesktopPermissionApi {
  request(directory: string): Promise<WaylandDesktopAccess>
  check(): Promise<WaylandDesktopAccess>
  close(): Promise<void>
  /** Fires when the shared grant changes without a new request. */
  subscribe?(listener: () => void): () => void
}

/** One Portal session supplies both permission fields without duplicate dialogs. */
export class WaylandDesktopPermissions {
  readonly requests: PermissionAccess
  readonly checks: PermissionAccess
  readonly #native: WaylandDesktopPermissionApi
  #request?: Promise<WaylandDesktopAccess>
  #check?: Promise<WaylandDesktopAccess>
  #closing?: Promise<void>
  #stopWatch?: () => void

  constructor(directory: string, native: WaylandDesktopPermissionApi) {
    this.#native = native
    const request = () => {
      if (this.#closing) return Promise.reject(new Error("Wayland desktop access is closing"))
      return this.#request ??= Promise.resolve().then(() => {
        if (this.#closing) throw new Error("Wayland desktop access is closing")
        return native.request(directory)
      })
        .finally(() => { this.#request = undefined })
    }
    const check = () => {
      if (this.#closing) return Promise.resolve({ screenCapture: false, control: false })
      return this.#check ??= Promise.resolve().then(() => native.check())
        .finally(() => { this.#check = undefined })
    }
    this.requests = {
      screenCapture: async () => (await request()).screenCapture,
      accessibility: async () => (await request()).control,
      fullDiskAccess: async () => null,
    }
    this.checks = {
      screenCapture: async () => (await check()).screenCapture,
      accessibility: async () => (await check()).control,
      fullDiskAccess: async () => null,
    }
  }

  /** Refreshes daemon permissions when capture stays up and remote input drops. */
  onAccessChanged(listener: () => void): void {
    this.#stopWatch?.()
    this.#stopWatch = this.#native.subscribe?.(listener)
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
