import assert from "node:assert/strict"
import { app, BrowserWindow, protocol, webContents } from "electron"
import { installRendererPermissions, registerRendererScheme } from "../../src/main/renderer-protocol.ts"
import { attachWebPreview, installWebPreview, WEB_PREVIEW_PARTITION } from "../../src/main/web-preview.ts"
import { secureWebPreferences } from "../../src/main/windows.ts"
import { rendererContentSecurityPolicy } from "../../src/shared/renderer-csp.ts"
import { BUNDLED_RENDERER_URL, RENDERER_SCHEME } from "../../src/shared/renderer-security.ts"

export interface WebPreviewSmokeContext {
  preloadPath: string
  allowedOrigin: string
  ungrantedOrigin: string
}

export interface WebPreviewSmokeResult {
  homeTitle: string
  homeBody: string
  nextTitle: string
  guestPreloadGlobal: string
  windowOpenReturnedNull: boolean
  blockedNavigations: string[]
  blockedAttaches: number
}

registerRendererScheme()

void app.whenReady().then(async () => {
  const argument = process.argv.find(value => value.startsWith("--web-preview-smoke-context="))
  if (!argument) throw new Error("Missing web preview smoke context")
  const context = JSON.parse(argument.slice("--web-preview-smoke-context=".length)) as WebPreviewSmokeContext

  installRendererPermissions()
  const csp = rendererContentSecurityPolicy(true)
  const html = `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Smoke</title></head><body><div id="host"></div></body></html>`

  protocol.handle(RENDERER_SCHEME, request => {
    if (request.method !== "GET") return new Response(null, { status: 405 })
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
  })

  const controller = installWebPreview({ onEvent: () => () => {} })
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: {
      ...secureWebPreferences({ webviewTag: true }),
      preload: context.preloadPath,
      additionalArguments: [],
    },
  })
  attachWebPreview(win)

  let blockedAttaches = 0
  const blockedNavigations: string[] = []
  let latestGuestId: number | null = null

  win.webContents.on("will-attach-webview", event => {
    if (event.defaultPrevented) blockedAttaches++
  })

  win.webContents.on("did-attach-webview", (_event, guestContents) => {
    latestGuestId = guestContents.id
    guestContents.on("will-navigate", (navEvent, url) => {
      if (navEvent.defaultPrevented) blockedNavigations.push(url)
    })
  })

  process.on("message", () => { controller.close(); app.quit() })
  process.on("disconnect", () => { controller.close(); app.quit() })
  win.webContents.on("render-process-gone", (_event, details) => process.send?.({ error: `Renderer exited: ${details.reason}` }))

  await win.loadURL(BUNDLED_RENDERER_URL)

  const mountHome = async () => win.webContents.executeJavaScript(`(async () => {
    const api = window.deskfleet.webPreview
    await api.allowOrigin(${JSON.stringify(context.allowedOrigin)})
    const host = document.getElementById("host")
    const wv = document.createElement("webview")
    wv.setAttribute("partition", ${JSON.stringify(WEB_PREVIEW_PARTITION)})
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out loading allowed webview")), 15000)
      wv.addEventListener("did-fail-load", e => {
        if (e.isMainFrame !== false && e.errorCode !== -3) {
          clearTimeout(timer)
          reject(new Error("webview failed to load: " + e.errorCode + " " + e.errorDescription))
        }
      })
      wv.addEventListener("did-finish-load", () => {
        clearTimeout(timer)
        resolve(wv.getWebContentsId())
      }, { once: true })
      wv.setAttribute("src", ${JSON.stringify(`${context.allowedOrigin}/`)})
      host.replaceChildren(wv)
    })
    window.__allowedWebview = wv
    return wv.getWebContentsId()
  })()`) as Promise<number>

  const guestId = await mountHome()
  assert.equal(guestId, latestGuestId)
  const guest = webContents.fromId(guestId)
  assert.ok(guest && !guest.isDestroyed(), "Guest webContents must be live")

  const [homeTitle, homeBody, guestPreloadGlobal, windowOpenReturnedNull] = await Promise.all([
    guest.executeJavaScript("document.title") as Promise<string>,
    guest.executeJavaScript('document.getElementById("status")?.textContent ?? ""') as Promise<string>,
    guest.executeJavaScript("typeof window.deskfleet") as Promise<string>,
    guest.executeJavaScript(`window.open(${JSON.stringify(context.allowedOrigin)}, "_blank") === null`) as Promise<boolean>,
  ])
  assert.equal(homeTitle, "Preview Home")
  assert.equal(homeBody, "ok")
  assert.equal(guestPreloadGlobal, "undefined")
  assert.equal(windowOpenReturnedNull, true)

  const nextTitle = await win.webContents.executeJavaScript(`(async () => {
    const wv = window.__allowedWebview
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out navigating to /next")), 15000)
      wv.addEventListener("did-finish-load", () => {
        clearTimeout(timer)
        resolve(undefined)
      }, { once: true })
      wv.loadURL(${JSON.stringify(`${context.allowedOrigin}/next`)})
    })
    return "loaded"
  })()`) as Promise<string>
  assert.equal(nextTitle, "loaded")
  const actualNextTitle = await guest.executeJavaScript("document.title") as string
  assert.equal(actualNextTitle, "Preview Next")

  const expectBlockedNavigation = async (targetUrl: string) => {
    const blocked = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for will-navigate on ${targetUrl}`)), 5_000)
      guest.once("will-navigate", (navEvent, url) => {
        clearTimeout(timer)
        assert.equal(navEvent.defaultPrevented, true, `Navigation to ${url} must be prevented`)
        resolve(url)
      })
    })
    await guest.executeJavaScript(`window.location.href = ${JSON.stringify(targetUrl)};`)
    assert.equal(await blocked, targetUrl)
  }

  const ungrantedUrl = `${context.ungrantedOrigin}/secret`
  await expectBlockedNavigation(ungrantedUrl)
  await expectBlockedNavigation("https://example.com/")
  await new Promise(resolve => setTimeout(resolve, 150))

  assert.equal(guest.getURL(), `${context.allowedOrigin}/next`)
  assert.deepEqual(blockedNavigations, [ungrantedUrl, "https://example.com/"])

  await win.webContents.executeJavaScript(`(async () => {
    const host = document.getElementById("host")
    const bad = document.createElement("webview")
    bad.setAttribute("partition", ${JSON.stringify(WEB_PREVIEW_PARTITION)})
    bad.setAttribute("src", ${JSON.stringify(ungrantedUrl)})
    host.appendChild(bad)
    await new Promise(resolve => setTimeout(resolve, 250))
  })()`)

  assert.equal(blockedAttaches, 1)

  const result: WebPreviewSmokeResult = {
    homeTitle,
    homeBody,
    nextTitle: actualNextTitle,
    guestPreloadGlobal,
    windowOpenReturnedNull,
    blockedNavigations,
    blockedAttaches,
  }
  process.send?.({ result })
}).catch(error => {
  process.send?.({ error: error instanceof Error ? error.stack || error.message : String(error) })
  app.quit()
})
