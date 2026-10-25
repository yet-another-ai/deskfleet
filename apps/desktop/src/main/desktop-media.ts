import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from "electron"
import { isEncoderFailure } from "../../../daemon/src/control-protocol.ts"
import { DESKTOP_MEDIA_CHANNEL, DESKTOP_MEDIA_EVENT } from "../../../../packages/client/src/desktop-media.ts"
import { isMainRendererUrl } from "../shared/renderer-security.ts"
import { DesktopMediaController } from "./desktop-media-controller.ts"
import { TERMINAL_SESSION_EVENT } from "../../../../packages/client/src/terminal.ts"
import { CATALOG_CHANGED_EVENT } from "../../../../packages/client/src/catalog.ts"
import { PROVIDERS_CHANGED_EVENT } from "../../../../packages/client/src/providers.ts"

const owners = new Map<WebContents, DesktopMediaController>()

export function isDesktopMediaSender(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">): boolean {
  return event.senderFrame !== null && event.senderFrame === event.sender.mainFrame
    && isMainRendererUrl(event.senderFrame.url)
}

export function installDesktopMediaIpc(): void {
  ipcMain.handle(DESKTOP_MEDIA_CHANNEL, (event, method: unknown, params: unknown) => {
    const owner = owners.get(event.sender)
    if (!owner || !isDesktopMediaSender(event) || typeof method !== "string") {
      throw new Error("Desktop IPC is restricted to the main renderer")
    }
    return owner.invoke(method, params).then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error), ...(isEncoderFailure(error) ? { reason: "encoder" as const } : {}) }),
    )
  })
}

export function attachDesktopMedia(window: BrowserWindow): void {
  const contents = window.webContents
  const attach = () => {
    owners.get(contents)?.dispose()
    owners.set(contents, new DesktopMediaController((event) => {
      if (!contents.isDestroyed()) contents.send(DESKTOP_MEDIA_EVENT, event)
    }, (event) => {
      if (!contents.isDestroyed()) contents.send(TERMINAL_SESSION_EVENT, event)
    }, () => {
      if (!contents.isDestroyed()) contents.send(CATALOG_CHANGED_EVENT)
    }, () => {
      if (!contents.isDestroyed()) contents.send(PROVIDERS_CHANGED_EVENT)
    }))
  }
  attach()
  // A document reload/crash must release capture even if its JS cannot clean up.
  contents.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) attach()
  })
  contents.on("render-process-gone", () => {
    owners.get(contents)?.dispose()
    owners.delete(contents)
  })
  contents.once("destroyed", () => {
    owners.get(contents)?.dispose()
    owners.delete(contents)
  })
}
