import { ipcMain, type BrowserWindow, type WebContents } from "electron"
import type { GoogleTagMessage } from "@deskfleet/client/google-tag"
import { GOOGLE_TAG_CHANNEL } from "../shared/google-tag-bridge.ts"
import { isMainRendererUrl } from "../shared/renderer-security.ts"
import { DesktopGoogleTagHost } from "./google-tag-host.ts"

const hosts = new Map<WebContents, DesktopGoogleTagHost>()

export function attachGoogleTag(window: BrowserWindow): void {
  const contents = window.webContents
  const host = new DesktopGoogleTagHost()
  hosts.set(contents, host)
  contents.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) host.close()
  })
  contents.on("render-process-gone", () => host.close())
  contents.once("destroyed", () => {
    host.close()
    hosts.delete(contents)
  })
}

export function installGoogleTag(): void {
  ipcMain.handle(GOOGLE_TAG_CHANNEL, (event, message: GoogleTagMessage) => {
    const host = hosts.get(event.sender)
    if (!host || !event.senderFrame || event.senderFrame !== event.sender.mainFrame
      || !isMainRendererUrl(event.senderFrame.url)) {
      throw new Error("Google Tag IPC is restricted to the main renderer")
    }
    return host.send(message)
  })
}
