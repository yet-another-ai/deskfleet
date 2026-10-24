import { ipcMain, type BrowserWindow, type WebContents } from "electron"
import type { LocalAgentState } from "../../../../packages/client/src/local-agent.ts"
import { SETTINGS_CHANNEL, SETTINGS_CHANGED_EVENT } from "../../../../packages/client/src/settings.ts"
import { isDesktopMediaSender } from "./desktop-media.ts"
import { getLaunchAtStartup, setLaunchAtStartup } from "./launch-at-startup.ts"
import type { LocalAgentController } from "./local-agent-controller.ts"

const renderers = new Set<WebContents>()

export function attachSettings(window: BrowserWindow): void {
  const contents = window.webContents
  renderers.add(contents)
  contents.once("destroyed", () => renderers.delete(contents))
}

export function publishLocalAgentState(state: LocalAgentState): void {
  for (const contents of renderers) {
    if (!contents.isDestroyed()) contents.send(SETTINGS_CHANGED_EVENT, state)
  }
}

export function installSettings(controller: LocalAgentController): void {
  ipcMain.handle(SETTINGS_CHANNEL, async (event, method: unknown, enabled: unknown) => {
    if (!renderers.has(event.sender) || !isDesktopMediaSender(event)) {
      throw new Error("Settings IPC is restricted to the main renderer")
    }
    try {
      switch (method) {
        case "get": return { ok: true, value: controller.state }
        case "setLocalAgentEnabled":
          if (typeof enabled !== "boolean") throw new Error("Local Agent setting must be a boolean")
          return { ok: true, value: await controller.setEnabled(enabled) }
        case "getLaunchAtStartup": return { ok: true, value: getLaunchAtStartup() }
        case "setLaunchAtStartup":
          if (typeof enabled !== "boolean") throw new Error("Launch at startup setting must be a boolean")
          return { ok: true, value: setLaunchAtStartup(enabled) }
        default: throw new Error("Unknown settings operation")
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
