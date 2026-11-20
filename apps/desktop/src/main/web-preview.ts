import { ipcMain, session, type BrowserWindow, type Session, type WebContents, type WebPreferences } from "electron"
import { WEB_PREVIEW_IPC_CHANNEL } from "../../../../packages/client/src/web-preview.ts"
import { isMainRendererUrl } from "../shared/renderer-security.ts"
import { isDesktopMediaSender } from "./desktop-media.ts"

export const WEB_PREVIEW_PARTITION = "temp:deskfleet-web-preview"

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/** Canonical HTTP loopback origin check for renderer-requested preview targets and guest navigations. */
export function parseLoopbackHttpOrigin(rawUrl: string): string | null {
  if (!rawUrl || rawUrl.includes("\0")) return null
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (
    parsed.protocol !== "http:"
    || parsed.username !== ""
    || parsed.password !== ""
    || !LOOPBACK_HOSTS.has(parsed.hostname)
  ) {
    return null
  }
  return parsed.origin
}

interface GuestEntry {
  owner: WebContents
  contents: WebContents
}

interface WebPreviewOptions {
  getSession?: (partition: string) => Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler" | "setDisplayMediaRequestHandler">
}

export class WebPreviewController {
  readonly #pendingOrigins = new Map<WebContents, string[]>()
  readonly #guests = new Map<number, GuestEntry>()
  readonly #attachedOwners = new WeakSet<WebContents>()
  readonly #getSession: NonNullable<WebPreviewOptions["getSession"]>
  #sessionConfigured = false

  constructor(options: WebPreviewOptions = {}) {
    this.#getSession = options.getSession ?? (partition => session.fromPartition(partition))
  }

  openDevTools(owner: WebContents, guestWebContentsId: number): void {
    if (!Number.isInteger(guestWebContentsId) || guestWebContentsId <= 0) {
      throw new Error("Invalid web preview guest ID")
    }
    const entry = this.#guests.get(guestWebContentsId)
    if (!entry || entry.owner !== owner) {
      throw new Error("Web preview guest does not belong to this window")
    }
    if (entry.contents.isDestroyed()) throw new Error("Web preview guest is unavailable")
    entry.contents.openDevTools({ mode: "detach", activate: true })
  }

  attachWindow(window: Pick<BrowserWindow, "webContents">): void {
    const owner = window.webContents
    if (this.#attachedOwners.has(owner)) return
    this.#attachedOwners.add(owner)
    this.#ensureSessionConfigured()

    owner.once("destroyed", () => this.#releaseOwner(owner))

    owner.on("will-attach-webview", (event, webPreferences: WebPreferences, params) => {
      const mainUrl = owner.mainFrame?.url || owner.getURL()
      const origin = parseLoopbackHttpOrigin(params.src ?? "")
      if (!isMainRendererUrl(mainUrl) || !origin) {
        event.preventDefault()
        return
      }
      const queue = this.#pendingOrigins.get(owner) ?? []
      queue.push(origin)
      this.#pendingOrigins.set(owner, queue)

      delete webPreferences.preload
      delete (webPreferences as Record<string, unknown>).preloadURL
      webPreferences.partition = WEB_PREVIEW_PARTITION
      webPreferences.nodeIntegration = false
      webPreferences.nodeIntegrationInWorker = false
      webPreferences.nodeIntegrationInSubFrames = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
      webPreferences.webSecurity = true
      webPreferences.allowRunningInsecureContent = false
      webPreferences.experimentalFeatures = false
      webPreferences.webviewTag = false
    })

    owner.on("did-attach-webview", (_event, guestContents) => {
      const queue = this.#pendingOrigins.get(owner)
      const queuedOrigin = queue?.shift()
      if (queue && queue.length === 0) this.#pendingOrigins.delete(owner)
      const pinnedOrigin = queuedOrigin ?? parseLoopbackHttpOrigin(guestContents.getURL())

      this.#guests.set(guestContents.id, { owner, contents: guestContents })
      guestContents.once("destroyed", () => {
        if (this.#guests.get(guestContents.id)?.contents === guestContents) {
          this.#guests.delete(guestContents.id)
        }
      })
      guestContents.setWindowOpenHandler(() => ({ action: "deny" }))
      const guardNavigation = (
        event: Electron.Event<Electron.WebContentsWillNavigateEventParams | Electron.WebContentsWillRedirectEventParams>,
        url: string,
      ) => {
        const targetUrl = event.url || url
        if (event.isMainFrame && targetUrl !== "about:blank" && (!pinnedOrigin || parseLoopbackHttpOrigin(targetUrl) !== pinnedOrigin)) {
          event.preventDefault()
        }
      }
      guestContents.on("will-navigate", guardNavigation)
      guestContents.on("will-redirect", guardNavigation)
    })
  }

  async openDevToolsFromIpc(
    event: Pick<Electron.IpcMainInvokeEvent, "sender" | "senderFrame">,
    guestWebContentsId: unknown,
  ): Promise<void> {
    if (!isDesktopMediaSender(event)) throw new Error("Web preview IPC is restricted to the main renderer")
    if (typeof guestWebContentsId !== "number") throw new Error("Invalid web preview guest ID")
    this.openDevTools(event.sender, guestWebContentsId)
  }

  close(): void {
    this.#pendingOrigins.clear()
    this.#guests.clear()
  }

  #releaseOwner(owner: WebContents): void {
    this.#pendingOrigins.delete(owner)
    for (const [guestId, entry] of this.#guests) {
      if (entry.owner === owner) this.#guests.delete(guestId)
    }
  }

  #ensureSessionConfigured(): void {
    if (this.#sessionConfigured) return
    this.#sessionConfigured = true
    const previewSession = this.#getSession(WEB_PREVIEW_PARTITION)
    previewSession.setPermissionCheckHandler(() => false)
    previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    previewSession.setDisplayMediaRequestHandler((_request, callback) => callback({}))
  }
}

let activeController: WebPreviewController | null = null

export function attachWebPreview(window: Pick<BrowserWindow, "webContents">): void {
  activeController?.attachWindow(window)
}

export function installWebPreview(): { close(): void } {
  activeController?.close()
  const controller = new WebPreviewController()
  activeController = controller
  ipcMain.handle(WEB_PREVIEW_IPC_CHANNEL, (event, guestWebContentsId: unknown) => controller.openDevToolsFromIpc(event, guestWebContentsId))
  return {
    close() {
      ipcMain.removeHandler(WEB_PREVIEW_IPC_CHANNEL)
      if (activeController === controller) activeController = null
      controller.close()
    },
  }
}
