import { app, BrowserWindow, type WebPreferences } from "electron"
import { join } from "node:path"
import { LOCALE_ARGUMENT_PREFIX, resolveAppLocale } from "../../../../packages/client/src/i18n.ts"
import { resolveRendererEntrypoint } from "../shared/renderer-security.ts"
import { attachDesktopMedia } from "./desktop-media.ts"
import { attachSettings } from "./settings.ts"
import { attachExternalLinks, isAuxiliaryRendererUrl } from "./external-links.ts"
import { attachAppearance } from "./appearance.ts"
import type { BackgroundLifecycle } from "./lifecycle.ts"
import { buildResourcePath } from "./paths.ts"
import { followSystemTheme, windowChromeOptions } from "./window-chrome.ts"

let mainWindow: BrowserWindow | null = null

export function secureWebPreferences(): WebPreferences {
  return {
    preload: join(import.meta.dirname, "../preload/index.cjs"),
    additionalArguments: [`${LOCALE_ARGUMENT_PREFIX}${resolveAppLocale(app.getPreferredSystemLanguages())}`],
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
  }
}

export async function showMainWindow(lifecycle: BackgroundLifecycle): Promise<void> {
  // The Dock icon is visible only while the window is.
  await app.dock?.show()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    return
  }

  const window = new BrowserWindow({
    show: false,
    width: 1360,
    height: 840,
    // Leaves the main pane usable beside both the sidebar and the details panel.
    minWidth: 960,
    minHeight: 560,
    // macOS takes the icon from the application bundle.
    ...(process.platform === "darwin" ? {} : { icon: buildResourcePath("icon.png") }),
    ...windowChromeOptions(process.platform),
    webPreferences: secureWebPreferences(),
  })
  mainWindow = window
  attachDesktopMedia(window)
  attachSettings(window)
  attachAppearance(window)
  followSystemTheme(window, process.platform)
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = null
  })
  window.once("ready-to-show", () => window.show())
  window.on("close", (event) => {
    if (lifecycle.quitting) return
    event.preventDefault()
    hideMainWindow()
  })
  // Windows ends the session through window messages rather than a quit request.
  window.on("session-end", () => lifecycle.quit())

  // The renderer is a single hash-routed document; auxiliary windows open only for standalone Mermaid views.
  attachExternalLinks(window.webContents, () => ({
    width: 960,
    height: 680,
    minWidth: 480,
    minHeight: 360,
    ...(process.platform === "darwin" ? {} : { icon: buildResourcePath("icon.png") }),
    ...windowChromeOptions(process.platform),
    webPreferences: secureWebPreferences(),
  }))
  window.webContents.on("did-create-window", (child) => {
    attachAppearance(child)
    followSystemTheme(child, process.platform)
    attachExternalLinks(child.webContents)
    child.webContents.on("will-navigate", (event, url) => {
      if (!isAuxiliaryRendererUrl(url)) event.preventDefault()
    })
  })
  window.webContents.on("will-navigate", (event) => event.preventDefault())
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("deskfleet renderer process exited", details)
  })
  window.webContents.on("did-fail-load", (_event, code, description) => {
    console.error("deskfleet renderer failed to load", { code, description })
  })

  const entrypoint = resolveRendererEntrypoint(app.isPackaged, process.env.DESKFLEET_RENDERER_URL)
  void window.loadURL(entrypoint.url)
}

/** Hides the client to the tray; the renderer keeps running. */
export function hideMainWindow(): void {
  mainWindow?.hide()
  app.dock?.hide()
}
