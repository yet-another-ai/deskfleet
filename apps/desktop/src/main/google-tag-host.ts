import { createHash, randomUUID } from "node:crypto"
import { session, WebContentsView, type Session } from "electron"
import { GOOGLE_TAG_CONNECT_ORIGINS, GOOGLE_TAG_IMG_ORIGINS, GOOGLE_TAG_SCRIPT_ORIGINS } from "@deskfleet/client/analytics-config"
import type { GoogleTagMessage } from "@deskfleet/client/google-tag"

const HOST_URL = "https://desktop-telemetry.invalid/"
const GOOGLE_ORIGINS = new Set<string>([
  ...GOOGLE_TAG_SCRIPT_ORIGINS,
  ...GOOGLE_TAG_CONNECT_ORIGINS,
  ...GOOGLE_TAG_IMG_ORIGINS,
  "https://stats.g.doubleclick.net",
  "https://www.google.com",
])

// GA4 checks document.location.protocol, independently of its page_location option.
// Only this isolated document needs HTTPS; application windows keep their origin.
const BOOTSTRAP = `
window.dataLayer = [];
window.gtag = function () { window.dataLayer.push(arguments); };
window.gtag("consent", "default", {
  analytics_storage: "denied", ad_storage: "denied",
  ad_user_data: "denied", ad_personalization: "denied"
});
window.__deskfleetGoogleTag = function (message) {
  if (message.type === "gtag") {
    // IPC preserves Date, but the JSON invocation below does not.
    if (message.args[0] === "js") message.args[1] = new Date(message.args[1]);
    window.gtag.apply(window, message.args);
  } else if (message.type === "dataLayer") {
    window.dataLayer.push(message.payload);
  } else if (message.type === "loadScript") {
    var script = document.createElement("script");
    script.async = true;
    script.src = message.src;
    document.head.appendChild(script);
  }
};`

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `script-src 'sha256-${createHash("sha256").update(BOOTSTRAP).digest("base64")}' ${GOOGLE_TAG_SCRIPT_ORIGINS.join(" ")}`,
  `connect-src ${[...GOOGLE_ORIGINS].join(" ")}`,
  `img-src ${[...GOOGLE_ORIGINS].join(" ")}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join("; ")

const denyRequest: Parameters<Session["webRequest"]["onBeforeRequest"]>[0] = (_request, callback) => callback({ cancel: true })

interface Runtime {
  view: WebContentsView
  session: Session
  ready: Promise<void>
}

function isGoogleRequest(url: string): boolean {
  try { return GOOGLE_ORIGINS.has(new URL(url).origin) } catch { return false }
}

function isTagScript(url: string): boolean {
  try {
    const parsed = new URL(url)
    return GOOGLE_TAG_SCRIPT_ORIGINS.some(origin => origin === parsed.origin)
      && (parsed.pathname === "/gtag/js" || parsed.pathname === "/gtm.js")
  } catch { return false }
}

function isTagMessage(message: GoogleTagMessage): boolean {
  if (!message || typeof message !== "object") return false
  switch (message.type) {
    case "reset": return true
    case "loadScript": return typeof message.src === "string" && isTagScript(message.src)
    case "dataLayer": return !!message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
    case "gtag": return Array.isArray(message.args)
      && ["consent", "js", "config", "set", "event"].includes(message.args[0] as string)
    default: return false
  }
}

/** A consent-scoped Google tag document with no access to the application bridge. */
export class DesktopGoogleTagHost {
  private runtime: Runtime | undefined
  private pending: GoogleTagMessage[] = []
  private queue: Promise<void> = Promise.resolve()

  send(message: GoogleTagMessage): Promise<void> {
    if (!isTagMessage(message)) return Promise.reject(new Error("Google tag message is not allowed"))
    if (message.type === "reset") {
      this.close()
      return Promise.resolve()
    }
    if (!this.runtime) {
      this.pending.push(message)
      // Default consent and other startup commands do not allocate a renderer.
      if (message.type !== "loadScript") return Promise.resolve()
      this.runtime = this.createRuntime()
      const messages = this.pending
      this.pending = []
      return this.enqueue(this.runtime, messages)
    }
    return this.enqueue(this.runtime, [message])
  }

  close(): void {
    const runtime = this.runtime
    this.runtime = undefined
    this.pending = []
    this.queue = Promise.resolve()
    if (!runtime) return
    if (!runtime.view.webContents.isDestroyed()) runtime.view.webContents.close({ waitForBeforeUnload: false })
    runtime.session.protocol.unhandle("https")
    runtime.session.webRequest.onBeforeRequest(denyRequest)
    void runtime.session.closeAllConnections().catch(() => {})
    void runtime.session.clearStorageData().catch(() => {})
  }

  private enqueue(runtime: Runtime, messages: GoogleTagMessage[]): Promise<void> {
    const delivery = this.queue.then(async () => {
      await runtime.ready
      for (const message of messages) {
        if (this.runtime !== runtime) return
        // Only JSON data crosses into a fixed invocation, never caller-supplied code.
        await runtime.view.webContents.executeJavaScript(`window.__deskfleetGoogleTag(${JSON.stringify(message)})`)
      }
    })
    this.queue = delivery.catch(() => {
      if (this.runtime === runtime) this.close()
    })
    return delivery
  }

  private createRuntime(): Runtime {
    const isolated = session.fromPartition(`deskfleet-google-tag-${randomUUID()}`)
    const view = new WebContentsView({
      webPreferences: {
        session: isolated,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    })
    const runtime: Runtime = { view, session: isolated, ready: Promise.resolve() }
    const active = () => this.runtime === runtime
    isolated.protocol.handle("https", request => {
      if (!active()) return new Response(null, { status: 403 })
      if (request.url === HOST_URL && request.method === "GET") {
        return new Response(`<!doctype html><meta charset="utf-8"><script>${BOOTSTRAP}</script>`, {
          headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CONTENT_SECURITY_POLICY },
        })
      }
      if (!isGoogleRequest(request.url)) return new Response(null, { status: 403 })
      return isolated.fetch(request, { bypassCustomProtocolHandlers: true })
    })
    isolated.webRequest.onBeforeRequest((request, callback) => {
      callback({ cancel: !active() || (request.url !== HOST_URL && !isGoogleRequest(request.url)) })
    })
    isolated.setPermissionCheckHandler(() => false)
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.on("will-download", event => event.preventDefault())
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    view.webContents.on("will-navigate", event => event.preventDefault())
    view.webContents.on("will-frame-navigate", event => event.preventDefault())
    // Set the current runtime before loading so the protocol handler can serve it.
    this.runtime = runtime
    runtime.ready = view.webContents.loadURL(HOST_URL)
    return runtime
  }
}
