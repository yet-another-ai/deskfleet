import { randomUUID } from "node:crypto"
import { ipcMain, session, webContents, type BrowserWindow, type Session, type WebContents, type WebPreferences } from "electron"
import type { CentralApi } from "@deskfleet/client/central"
import { WEB_PREVIEW_IPC_CHANNEL } from "../../../../packages/client/src/web-preview.ts"
import { isMainRendererUrl } from "../shared/renderer-security.ts"
import { isDesktopMediaSender } from "./desktop-media.ts"

export const WEB_PREVIEW_PARTITION = "temp:deskfleet-web-preview"

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/** Canonical HTTP loopback origin check for renderer-requested preview targets. */
export function isLoopbackHttpOrigin(origin: string): boolean {
  if (!origin || origin.includes("\0")) return false
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  return (
    parsed.protocol === "http:"
    && parsed.origin === origin
    && parsed.username === ""
    && parsed.password === ""
    && LOOPBACK_HOSTS.has(parsed.hostname)
  )
}

interface OriginGrant {
  owner: WebContents
  origin: string
}

interface GuestEntry {
  owner: WebContents
  contents: WebContents
}

interface WebPreviewOptions {
  getSession?: (partition: string) => Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler" | "setDisplayMediaRequestHandler">
  resolveWebContents?: (id: number) => WebContents | undefined
}

export class WebPreviewController {
  readonly #grants = new Map<string, OriginGrant>()
  readonly #guests = new Map<number, GuestEntry>()
  readonly #attachedOwners = new WeakSet<WebContents>()
  readonly #getSession: NonNullable<WebPreviewOptions["getSession"]>
  readonly #resolveWebContents: NonNullable<WebPreviewOptions["resolveWebContents"]>
  readonly #unsubscribe: () => void
  #sessionConfigured = false
  #closed = false

  constructor(central: Pick<CentralApi, "onEvent">, options: WebPreviewOptions = {}) {
    this.#getSession = options.getSession ?? (partition => session.fromPartition(partition))
    this.#resolveWebContents = options.resolveWebContents ?? (id => webContents.fromId(id))
    this.#unsubscribe = central.onEvent(event => {
      if (event.type === "accountChanged") this.#grants.clear()
    })
  }

  allowOrigin(owner: WebContents, origin: string): string {
    if (this.#closed) throw new Error("Web preview controller is closed")
    if (!isLoopbackHttpOrigin(origin)) throw new Error("Web preview origin must be a loopback HTTP origin")
    this.#ensureSessionConfigured()
    const grantId = randomUUID()
    this.#grants.set(grantId, { owner, origin })
    return grantId
  }

  revokeOrigin(owner: WebContents, grantId: string): void {
    const grant = this.#grants.get(grantId)
    if (grant?.owner === owner) this.#grants.delete(grantId)
  }

  isAllowedUrl(owner: WebContents, rawUrl: string): boolean {
    if (!rawUrl || rawUrl.includes("\0")) return false
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return false
    }
    if (parsed.protocol !== "http:" || parsed.username !== "" || parsed.password !== "") return false
    for (const grant of this.#grants.values()) {
      if (grant.owner === owner && grant.origin === parsed.origin) return true
    }
    return false
  }

  openDevTools(owner: WebContents, guestWebContentsId: number): void {
    if (!Number.isInteger(guestWebContentsId) || guestWebContentsId <= 0) {
      throw new Error("Invalid web preview guest ID")
    }
    const entry = this.#guests.get(guestWebContentsId)
    if (!entry || entry.owner !== owner) {
      throw new Error("Web preview guest does not belong to this window")
    }
    const guest = !entry.contents.isDestroyed() ? entry.contents : this.#resolveWebContents(guestWebContentsId)
    if (!guest || guest.isDestroyed()) throw new Error("Web preview guest is unavailable")
    guest.openDevTools({ mode: "detach", activate: true })
  }

  attachWindow(window: Pick<BrowserWindow, "webContents">): void {
    const owner = window.webContents
    if (this.#attachedOwners.has(owner)) return
    this.#attachedOwners.add(owner)
    this.#ensureSessionConfigured()

    owner.once("destroyed", () => this.#releaseOwner(owner))

    owner.on("will-attach-webview", (event, webPreferences: WebPreferences, params) => {
      const mainUrl = owner.mainFrame?.url || owner.getURL()
      const src = params.src ?? ""
      if (!isMainRendererUrl(mainUrl) || (src !== "" && src !== "about:blank" && !this.isAllowedUrl(owner, src))) {
        event.preventDefault()
        return
      }
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
        if (event.isMainFrame && targetUrl !== "about:blank" && !this.isAllowedUrl(owner, targetUrl)) {
          event.preventDefault()
        }
      }
      guestContents.on("will-navigate", guardNavigation)
      guestContents.on("will-redirect", guardNavigation)
    })
  }

  async invoke(
    event: Pick<Electron.IpcMainInvokeEvent, "sender" | "senderFrame">,
    method: unknown,
    args: unknown,
  ): Promise<unknown> {
    if (!isDesktopMediaSender(event)) throw new Error("Web preview IPC is restricted to the main renderer")
    if (typeof method !== "string" || !Array.isArray(args)) throw new Error("Invalid web preview operation")
    switch (method) {
      case "allowOrigin":
        if (typeof args[0] !== "string") throw new Error("Invalid web preview origin")
        return this.allowOrigin(event.sender, args[0])
      case "revokeOrigin":
        if (typeof args[0] !== "string" || !args[0]) throw new Error("Invalid web preview grant")
        this.revokeOrigin(event.sender, args[0])
        return undefined
      case "openDevTools":
        if (typeof args[0] !== "number") throw new Error("Invalid web preview guest ID")
        this.openDevTools(event.sender, args[0])
        return undefined
      default:
        throw new Error("Unknown web preview operation")
    }
  }

  close(): void {
    this.#closed = true
    this.#grants.clear()
    this.#guests.clear()
    this.#unsubscribe()
  }

  #releaseOwner(owner: WebContents): void {
    for (const [grantId, grant] of this.#grants) {
      if (grant.owner === owner) this.#grants.delete(grantId)
    }
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

export function installWebPreview(central: Pick<CentralApi, "onEvent">): { close(): void } {
  activeController?.close()
  const controller = new WebPreviewController(central)
  activeController = controller
  ipcMain.handle(WEB_PREVIEW_IPC_CHANNEL, (event, method: unknown, args: unknown) => controller.invoke(event, method, args))
  return {
    close() {
      ipcMain.removeHandler(WEB_PREVIEW_IPC_CHANNEL)
      if (activeController === controller) activeController = null
      controller.close()
    },
  }
}
