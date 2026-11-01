import type { WindowsDesktopServiceState } from "../../../../packages/client/src/windows-desktop-service.ts"

export type WindowsDesktopServiceCommand = "status" | "elevate-install" | "elevate-uninstall"
export type WindowsDesktopServiceRunner = (command: WindowsDesktopServiceCommand) => Promise<string>

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
    return { available: true, installed: state.installed, running: state.running }
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
}
