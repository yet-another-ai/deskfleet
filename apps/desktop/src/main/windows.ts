import { app, BrowserWindow, type BrowserWindowConstructorOptions, type WebPreferences } from "electron"
import { join } from "node:path"
import { LOCALE_ARGUMENT_PREFIX, resolveAppLocale } from "../../../../packages/client/src/i18n.ts"
import { sessionWindowKey } from "@deskfleet/client/session-window"
import { resolveRendererEntrypoint } from "../shared/renderer-security.ts"
import { attachDesktopMedia } from "./desktop-media.ts"
import { attachSettings } from "./settings.ts"
import { attachExternalLinks, isAuxiliaryRendererUrl, parseSessionWindowUrl } from "./external-links.ts"
import { attachAppearance } from "./appearance.ts"
import { attachUpdates } from "./updates.ts"
import { attachWindowsDesktopService } from "./windows-desktop-service.ts"
import type { BackgroundLifecycle } from "./lifecycle.ts"
import { buildResourcePath } from "./paths.ts"
import { followSystemTheme, windowChromeOptions } from "./window-chrome.ts"
import { attachApplication } from "./application.ts"
import { attachGoogleTag } from "./google-tag.ts"
import { attachWebPreview } from "./web-preview.ts"

let mainWindow: BrowserWindow | null = null
const sessionWindows = new Map<string, BrowserWindow>()

export function secureWebPreferences(options: { webviewTag?: boolean } = {}): WebPreferences {
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
    webviewTag: options.webviewTag ?? false,
  }
}

function auxiliaryWindowOptions(url: string): BrowserWindowConstructorOptions | null {
  const sessionTarget = parseSessionWindowUrl(url)
  if (sessionTarget) {
    const existing = sessionWindows.get(sessionWindowKey(sessionTarget))
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return null
    }
  }
  return {
    title: "DeskFleet",
    ...(sessionTarget
      ? { width: 1120, height: 780, minWidth: 720, minHeight: 520 }
      : { width: 960, height: 680, minWidth: 480, minHeight: 360 }),
    ...(process.platform === "darwin" ? {} : { icon: buildResourcePath("icon.png") }),
    ...windowChromeOptions(process.platform),
    webPreferences: secureWebPreferences({ webviewTag: Boolean(sessionTarget) }),
  }
}

function attachRendererWindow(window: BrowserWindow): void {
  attachApplication(window)
  attachWebPreview(window)
  attachGoogleTag(window)
  attachDesktopMedia(window)
  attachSettings(window)
  attachAppearance(window)
  attachUpdates(window)
  attachWindowsDesktopService(window)
  followSystemTheme(window, process.platform)

  // The renderer is a single hash-routed document; standalone previews and Session views open in auxiliary windows.
  attachExternalLinks(window.webContents, auxiliaryWindowOptions)
  window.webContents.on("did-create-window", (child, details) => {
    const sessionTarget = parseSessionWindowUrl(details.url)
    if (sessionTarget) {
      const key = sessionWindowKey(sessionTarget)
      sessionWindows.set(key, child)
      child.once("closed", () => {
        if (sessionWindows.get(key) === child) sessionWindows.delete(key)
      })
      attachRendererWindow(child)
      return
    }
    attachAppearance(child)
    followSystemTheme(child, process.platform)
    attachExternalLinks(child.webContents)
    child.webContents.on("will-navigate", (event, url) => {
      if (event.frame === child.webContents.mainFrame && !isAuxiliaryRendererUrl(url)) event.preventDefault()
    })
  })
  window.webContents.on("will-navigate", (event, url) => {
    if (event.frame === window.webContents.mainFrame && !isAuxiliaryRendererUrl(url)) event.preventDefault()
  })
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("DeskFleet renderer process exited", details)
  })
  window.webContents.on("did-fail-load", (_event, code, description) => {
    console.error("DeskFleet renderer failed to load", { code, description })
  })
}

export async function showMainWindow(lifecycle: BackgroundLifecycle, hash = ""): Promise<void> {
  // The Dock icon is visible only while a window is.
  await app.dock?.show()
  const entrypoint = resolveRendererEntrypoint(app.isPackaged, process.env.DESKFLEET_RENDERER_URL)
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (hash) void mainWindow.loadURL(`${entrypoint.url}${hash}`)
    // Hiding the Dock icon resets macOS focus, which otherwise tabs into the first control on show.
    if (!mainWindow.isVisible()) mainWindow.webContents.focus()
    mainWindow.show()
    mainWindow.focus()
    return
  }

  const window = new BrowserWindow({
    title: "DeskFleet",
    show: false,
    width: 1360,
    height: 840,
    // Leaves the main pane usable beside both the sidebar and the details panel.
    minWidth: 960,
    minHeight: 560,
    // macOS takes the icon from the application bundle.
    ...(process.platform === "darwin" ? {} : { icon: buildResourcePath("icon.png") }),
    ...windowChromeOptions(process.platform),
    webPreferences: secureWebPreferences({ webviewTag: true }),
  })
  mainWindow = window
  attachRendererWindow(window)
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

  void window.loadURL(`${entrypoint.url}${hash}`)
}

/** Hides the client to the tray; the renderer keeps running. */
export function hideMainWindow(): void {
  mainWindow?.hide()
  app.dock?.hide()
}

export async function openMainWindowNotificationSession(
  lifecycle: BackgroundLifecycle,
  target: { teamId: string; machineId: string; sessionId: string },
): Promise<void> {
  await showMainWindow(lifecycle)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("deskfleet:open-notification-session", {
      teamId: target.teamId,
      machineId: target.machineId,
      sessionId: target.sessionId,
    })
  }
}
