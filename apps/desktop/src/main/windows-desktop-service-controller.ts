import type { WindowsDesktopServiceState } from "../../../../packages/client/src/windows-desktop-service.ts"

export type WindowsDesktopServiceCommand = "status" | "maintenance-update" | "elevate-install" | "elevate-uninstall"
export type WindowsDesktopServiceRunner = (command: WindowsDesktopServiceCommand) => Promise<string>

function optionalBoolean(value: object, key: string): boolean | undefined {
  if (!(key in value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  if (typeof field !== "boolean") throw new Error("Windows desktop service returned an invalid status")
  return field
}

/** Installation state comes from Windows, not a saved UI preference. */
export class WindowsDesktopServiceController {
  #available: boolean
  #run: WindowsDesktopServiceRunner
  #changing = false

  constructor(available: boolean, run: WindowsDesktopServiceRunner) {
    this.#available = available
    this.#run = run
  }

  async get(): Promise<WindowsDesktopServiceState> {
    if (!this.#available) return { available: false, installed: false, running: false }
    const state: unknown = JSON.parse(await this.#run("status"))
    if (!state || typeof state !== "object" || !("installed" in state) || typeof state.installed !== "boolean"
      || !("running" in state) || typeof state.running !== "boolean") {
      throw new Error("Windows desktop service returned an invalid status")
    }
    const maintenanceInstalled = optionalBoolean(state, "maintenanceInstalled")
    const updateAvailable = optionalBoolean(state, "updateAvailable")
    const silentUpdateAvailable = optionalBoolean(state, "silentUpdateAvailable")
    return {
      available: true,
      installed: state.installed,
      running: state.running,
      ...(maintenanceInstalled !== undefined ? { maintenanceInstalled } : {}),
      ...(updateAvailable !== undefined ? { updateAvailable } : {}),
      ...(silentUpdateAvailable !== undefined ? { silentUpdateAvailable } : {}),
    }
  }

  async setEnabled(enabled: boolean): Promise<WindowsDesktopServiceState> {
    if (!this.#available) throw new Error("Windows desktop service is unavailable in this build")
    if (this.#changing) throw new Error("Windows desktop service setup is already in progress")
    this.#changing = true
    try {
      const current = await this.get()
      if (enabled ? !current.installed || !current.running : current.installed) {
        await this.#run(enabled ? "elevate-install" : "elevate-uninstall")
      }
      return await this.get()
    } finally { this.#changing = false }
  }

  /**
   * Updates an already-installed desktop service. Uses the on-demand
   * `DeskFleetMaintenance` service without UAC when a signed update is
   * available, otherwise requests administrator approval to install or migrate
   * both services while the app stays online.
   */
  async update(): Promise<WindowsDesktopServiceState> {
    if (!this.#available) throw new Error("Windows desktop service is unavailable in this build")
    if (this.#changing) throw new Error("Windows desktop service setup is already in progress")
    this.#changing = true
    try {
      const current = await this.get()
      if (!current.installed) return current
      if (current.silentUpdateAvailable) {
        await this.#run("maintenance-update")
      } else if (current.updateAvailable || !current.running || !current.maintenanceInstalled) {
        await this.#run("elevate-install")
      }
      return await this.get()
    } finally { this.#changing = false }
  }

  /**
   * Automatically applies signed desktop service updates on app startup through
   * `DeskFleetMaintenance`. Never requests UAC elevation unattended.
   */
  async reconcileOnStartup(): Promise<void> {
    if (!this.#available || this.#changing) return
    const current = await this.get()
    if (!current.installed || !current.silentUpdateAvailable) return
    this.#changing = true
    try {
      await this.#run("maintenance-update")
    } finally { this.#changing = false }
  }
}
