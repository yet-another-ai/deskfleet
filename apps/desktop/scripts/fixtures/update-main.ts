import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { app, BrowserWindow, net, protocol } from "electron"
import type { DeskfleetDesktopApi } from "../../../../packages/client/src/desktop-api.ts"
import { AppearanceSettingsController } from "../../src/main/appearance-settings.ts"
import { attachAppearance, installAppearance } from "../../src/main/appearance.ts"
import { installRendererPermissions, registerRendererScheme, resolveRendererResourcePath } from "../../src/main/renderer-protocol.ts"
import { UpdateController, type UpdateDriver } from "../../src/main/update-controller.ts"
import { attachUpdates, installUpdateIpc, publishUpdateState } from "../../src/main/updates.ts"
import { windowChromeOptions } from "../../src/main/window-chrome.ts"
import { BUNDLED_RENDERER_URL, RENDERER_SCHEME } from "../../src/shared/renderer-security.ts"

export interface UpdateSmokeContext {
  rendererDirectory: string
  preloadPath: string
  profileDirectory: string
  outputDirectory: string
}
export interface UpdateSmokeResult { downloads: number; installs: number; shutdowns: number; screenshots: string[] }

async function inspectNotice(expected: string | null) {
  const deadline = Date.now() + 12_000
  while (true) {
    const sidebar = document.querySelector("aside")
    const notice = sidebar?.querySelector<HTMLElement>("[data-app-update]")
    const button = notice?.querySelector<HTMLButtonElement>("button")
    if (sidebar && (expected === null ? !notice : button?.textContent?.trim() === expected)) {
      if (notice && button) {
        const bounds = notice.getBoundingClientRect()
        const footer = notice.nextElementSibling?.getBoundingClientRect()
        if (!footer || bounds.bottom > footer.top + 1 || bounds.left > 20 || bounds.width < 180) throw new Error("Update notice must sit above the bottom-left footer")
        if (button.scrollWidth > button.clientWidth || bounds.bottom > innerHeight) throw new Error("Update notice overflows")
      }
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      return { disabled: button?.disabled, text: notice?.textContent }
    }
    if (Date.now() >= deadline) throw new Error(`Update notice ${expected} timed out: ${document.body.innerText}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function setAppearance(theme: "light" | "dark", language: "en-US" | "zh-cmn-Hans-CN") {
  const api = (window as unknown as { deskfleet: DeskfleetDesktopApi }).deskfleet
  await api.appearance!.set({ ...await api.appearance!.get(), theme, language })
}

registerRendererScheme()
void app.whenReady().then(async () => {
  const argument = process.argv.find(value => value.startsWith("--updates-smoke-context="))
  if (!argument) throw new Error("Missing update smoke context")
  const context = JSON.parse(argument.slice("--updates-smoke-context=".length)) as UpdateSmokeContext
  installRendererPermissions()
  protocol.handle(RENDERER_SCHEME, request => {
    const path = resolveRendererResourcePath(request.url, context.rendererDirectory)
    return request.method === "GET" && path ? net.fetch(pathToFileURL(path).toString()) : new Response(null, { status: 400 })
  })
  const appearance = new AppearanceSettingsController(join(context.profileDirectory, "appearance.json"))
  appearance.set({ ...appearance.get(), theme: "light", language: "en-US" })
  installAppearance(appearance)
  let version: string | null = null
  let downloads = 0
  let installs = 0
  const installCount = () => installs
  let shutdowns = 0
  let progress: ((percent: number) => void) | undefined
  let finishDownload: (() => void) | undefined
  let releaseShutdown: (() => void) | undefined
  const driver: UpdateDriver = {
    check: async () => version,
    async download(onProgress) {
      downloads++
      if (downloads === 1) throw new Error("Download interrupted by smoke fixture")
      progress = onProgress
      await new Promise<void>(resolve => { finishDownload = resolve })
    },
    install() { assert.equal(shutdowns, 1, "Installation must wait for shutdown"); installs++ },
    close() {},
  }
  const controller = new UpdateController(driver, publishUpdateState, async () => {
    await new Promise<void>(resolve => { releaseShutdown = resolve })
    shutdowns++
  })
  installUpdateIpc(controller)
  process.on("message", () => { controller.close(); app.quit() })
  process.on("disconnect", () => { controller.close(); app.quit() })
  async function createWindow(account = false): Promise<BrowserWindow> {
    const window = new BrowserWindow({
      show: false, width: 1200, height: 800, ...windowChromeOptions(process.platform),
      webPreferences: {
        preload: context.preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false, offscreen: true,
        additionalArguments: ["--deskfleet-locale=en-US", ...(account ? ["--updates-account"] : [])],
      },
    })
    attachAppearance(window)
    attachUpdates(window)
    window.webContents.on("render-process-gone", (_event, details) => process.send?.({ error: `Renderer exited: ${details.reason}` }))
    await window.loadURL(`${BUNDLED_RENDERER_URL}#/`)
    return window
  }
  const screenshots: string[] = []
  const inspect = (window: BrowserWindow, expected: string | null) => window.webContents.executeJavaScript(`(${inspectNotice.toString()})(${JSON.stringify(expected)})`) as Promise<{ disabled?: boolean; text?: string }>
  async function screenshot(window: BrowserWindow, name: string): Promise<void> {
    const path = join(context.outputDirectory, `${name}.png`)
    await new Promise(resolve => setTimeout(resolve, 250))
    const pixels = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Update screenshot paint timed out")), 5_000)
      window.webContents.once("paint", (_event, _dirty, image) => { clearTimeout(timer); resolve(image.toPNG()) })
      window.webContents.invalidate()
    })
    await writeFile(path, pixels)
    screenshots.push(path)
  }
  const local = await createWindow()
  controller.start()
  await inspect(local, null)
  assert.equal(downloads, 0)
  version = "0.2.0"
  await controller.check()
  assert.equal((await inspect(local, "Update and restart")).disabled, false)
  assert.equal(downloads, 0, "Available updates must not download before a click")
  await screenshot(local, "updates-available-en-light")
  const account = await createWindow(true)
  await inspect(account, "Update and restart")
  await screenshot(account, "updates-account-en-light")
  account.destroy()
  await local.webContents.executeJavaScript(`(${setAppearance.toString()})("dark", "zh-cmn-Hans-CN")`)
  await inspect(local, "更新并重启")
  await screenshot(local, "updates-available-zh-dark")
  local.setSize(960, 700)
  await local.webContents.executeJavaScript(`(() => {
    const separator = document.querySelector('[role="separator"][aria-orientation="vertical"]')
    for (let index = 0; index < 4; index++) separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  })()`)
  await inspect(local, "更新并重启")
  await screenshot(local, "updates-minimum-zh-dark")
  const click = () => local.webContents.executeJavaScript(`document.querySelector('[data-app-update] button').click()`)
  await click()
  await inspect(local, "重试更新")
  assert.equal(downloads, 1)
  assert.equal(installs, 0)
  await screenshot(local, "updates-error-zh-dark")
  await click()
  await inspect(local, "正在下载 0%")
  assert.equal(downloads, 2)
  progress!(37)
  assert.equal((await inspect(local, "正在下载 37%")).disabled, true)
  await click()
  assert.equal(downloads, 2, "Disabled progress button must not start another download")
  await screenshot(local, "updates-downloading-zh-dark")
  progress!(100)
  finishDownload!()
  await inspect(local, "正在重启…")
  assert.equal(installs, 0, "Installer must wait for the shutdown barrier")
  await screenshot(local, "updates-installing-zh-dark")
  releaseShutdown!()
  const deadline = Date.now() + 5_000
  while (installCount() !== 1) {
    if (Date.now() >= deadline) throw new Error("Installation did not follow shutdown")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(shutdowns, 1)
  controller.close()
  process.send?.({ result: { downloads, installs, shutdowns, screenshots } satisfies UpdateSmokeResult })
}).catch(error => { process.send?.({ error: String(error) }); app.quit() })
