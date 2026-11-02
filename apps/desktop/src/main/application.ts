import { ipcMain, type BrowserWindow, type WebContents } from "electron"
import { APPLICATION_RESTART_CHANNEL } from "@deskfleet/client/application"
import type { BackgroundLifecycle } from "./lifecycle.ts"
import { isMainRendererUrl } from "../shared/renderer-security.ts"

const renderers = new Set<WebContents>()

export function attachApplication(window: BrowserWindow): void {
  const contents = window.webContents
  renderers.add(contents)
  contents.once("destroyed", () => renderers.delete(contents))
}

export function installApplication(lifecycle: BackgroundLifecycle): void {
  ipcMain.handle(APPLICATION_RESTART_CHANNEL, event => {
    if (!renderers.has(event.sender) || !event.senderFrame || event.senderFrame !== event.sender.mainFrame
      || !isMainRendererUrl(event.senderFrame.url)) {
      throw new Error("Application IPC is restricted to the main renderer")
    }
    lifecycle.restart()
  })
}
