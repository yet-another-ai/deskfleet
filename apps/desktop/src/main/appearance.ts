import { app, ipcMain, nativeTheme, type BrowserWindow, type WebContents } from "electron"
import { APPEARANCE_CHANNEL, APPEARANCE_CHANGED_EVENT, DEFAULT_APPEARANCE_SETTINGS, validateAppearanceSettings, type AppearanceSettings } from "../../../../packages/client/src/appearance.ts"
import { resolveAppLocale } from "../../../../packages/client/src/i18n.ts"
import { isMainRendererUrl } from "../shared/renderer-security.ts"
import type { AppearanceSettingsController } from "./appearance-settings.ts"
import { setMainLocale } from "./i18n.ts"
import { refreshTrayMenu } from "./tray.ts"

const renderers = new Set<WebContents>()

export function attachAppearance(window: BrowserWindow): void {
  const contents = window.webContents
  renderers.add(contents)
  contents.once("destroyed", () => renderers.delete(contents))
}

function applyAppearance(settings: AppearanceSettings): void {
  nativeTheme.themeSource = settings.theme
  setMainLocale(settings.language === "system" ? resolveAppLocale(app.getPreferredSystemLanguages()) : settings.language)
  refreshTrayMenu()
}

export function installAppearance(controller: AppearanceSettingsController): void {
  // Load native colors and language before constructing windows or the tray.
  try { applyAppearance(controller.get()) } catch (error) {
    console.error(error)
    applyAppearance(DEFAULT_APPEARANCE_SETTINGS)
  }
  ipcMain.handle(APPEARANCE_CHANNEL, (event, method: unknown, value: unknown) => {
    if (!renderers.has(event.sender) || !event.senderFrame || event.senderFrame !== event.sender.mainFrame
      || !isMainRendererUrl(event.senderFrame.url)) {
      throw new Error("Appearance IPC is restricted to application renderers")
    }
    try {
      if (method === "get") return { ok: true, value: controller.get() }
      if (method !== "set") throw new Error("Unknown appearance operation")
      const settings = controller.set(validateAppearanceSettings(value))
      applyAppearance(settings)
      for (const contents of renderers) {
        if (!contents.isDestroyed()) contents.send(APPEARANCE_CHANGED_EVENT, settings)
      }
      return { ok: true, value: settings }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
