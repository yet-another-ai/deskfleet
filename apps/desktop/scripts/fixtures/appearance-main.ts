import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { app, BrowserWindow, nativeTheme, net, protocol } from "electron"
import type { AppearanceSettings } from "../../../../packages/client/src/appearance.ts"
import type { DeskfleetDesktopApi } from "../../../../packages/client/src/desktop-api.ts"
import { AppearanceSettingsController } from "../../src/main/appearance-settings.ts"
import { attachAppearance, installAppearance } from "../../src/main/appearance.ts"
import { getMainLocale } from "../../src/main/i18n.ts"
import { installRendererPermissions, registerRendererScheme, resolveRendererResourcePath } from "../../src/main/renderer-protocol.ts"
import { followSystemTheme, windowChromeOptions } from "../../src/main/window-chrome.ts"
import { BUNDLED_RENDERER_URL, RENDERER_SCHEME } from "../../src/shared/renderer-security.ts"

export interface AppearanceSmokeContext {
  phase: "change" | "restore"
  rendererDirectory: string
  preloadPath: string
  profileDirectory: string
  outputDirectory: string
}

export interface AppearanceSmokeResult {
  settings: AppearanceSettings
  background: string
  interfaceFont: string
  terminalFont: string
  terminalLigatures: boolean
  joinedOperators: string[]
  language: string
  nativeTheme: string
  screenshots: string[]
}

// Exercises controls inside the built renderer with the real appearance preload.
async function exerciseAppearance(phase: "change" | "restore", theme?: "light" | "dark" | "system", ligatures?: boolean) {
  const api = (window as unknown as { deskfleet: DeskfleetDesktopApi }).deskfleet
  const appearance = api.appearance!
  function require(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
  }
  async function until(predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
    const deadline = Date.now() + 12_000
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error(`${description} timed out: ${document.body.innerText.slice(-2_000)}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  const control = (name: string) => document.querySelector<HTMLButtonElement>(`[data-control-name="appearance-${name}"]`)
  async function select(name: "language", label: string): Promise<void> {
    await until(() => !!control(name) && !control(name)!.disabled, `${name} control`)
    const trigger = control(name)!
    trigger.focus()
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    const option = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(element => element.textContent?.trim() === label)
    await until(() => !!option(), `${label} option`)
    option()!.focus()
    option()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await until(() => !document.querySelector('[role="listbox"]') && !control(name)?.disabled, `${label} selection`)
  }
  async function selectTheme(value: "light" | "dark" | "system"): Promise<void> {
    const choice = () => document.querySelector<HTMLButtonElement>(`[data-appearance-theme="${value}"]`)
    await until(() => !!choice() && !choice()!.disabled, `${value} theme thumbnail`)
    require(choice()!.getAttribute("role") === "radio", "Theme thumbnails must be radio choices")
    choice()!.click()
    await until(async () => (await appearance.get()).theme === value && choice()!.getAttribute("aria-checked") === "true" && !choice()!.disabled, `${value} theme selection`)
  }
  const terminal = () => document.querySelector<HTMLElement>("[data-terminal-font-preview] .xterm")
  const rows = () => document.querySelector<HTMLElement>("[data-terminal-font-preview] .xterm-rows")
  const joinedOperators = () => [...document.querySelectorAll<HTMLElement>("[data-terminal-font-preview] .xterm-rows span")]
    .map(span => span.textContent ?? "").filter(text => ["=>", "->", "===", "!=="].includes(text))
  async function toggleLigatures(enabled: boolean): Promise<void> {
    const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"][aria-labelledby="appearance-terminal-ligatures-label"]')
    await until(() => !!toggle() && !toggle()!.disabled, "Terminal ligature switch")
    const original = terminal()
    if ((toggle()!.getAttribute("aria-checked") === "true") !== enabled) toggle()!.click()
    await until(async () => (await appearance.get()).terminalLigatures === enabled && !toggle()!.disabled, "Saved terminal ligatures")
    await until(() => {
      const features = terminal()?.style.fontFeatureSettings ?? ""
      return enabled ? features.includes('"calt"') && !/"calt"\s+(?:0|off)/u.test(features) && joinedOperators().length > 0
        : /"calt"\s+(?:0|off)/u.test(features) && /"liga"\s+(?:0|off)/u.test(features) && joinedOperators().length === 0
    }, "Live terminal ligature rendering")
    require(terminal() === original, "Ligature changes must update the existing terminal preview")
  }
  async function font(name: "interface" | "terminal", value: string): Promise<void> {
    const input = document.querySelector<HTMLInputElement>(`#appearance-${name}-font`)!
    const saved = await appearance.get()
    const original = terminal()
    input.value = value
    input.dispatchEvent(new Event("input", { bubbles: true }))
    if (name === "terminal") {
      await until(() => !!rows() && getComputedStyle(rows()!).fontFamily === value, "Draft terminal font preview")
      require((await appearance.get()).terminalFont === saved.terminalFont, "Terminal preview must update before committing the font")
      require(terminal() === original, "Font changes must update the existing terminal preview")
    }
    input.dispatchEvent(new Event("change", { bubbles: true }))
    await until(async () => (await appearance.get())[name === "interface" ? "interfaceFont" : "terminalFont"] === value && !input.disabled, `${name} font saved`)
  }
  await until(() => !!document.querySelector('a[href="#/settings/appearance"]'), "Appearance navigation")
  document.querySelector<HTMLAnchorElement>('a[href="#/settings/appearance"]')!.click()
  await until(() => !!control("language") && !control("language")!.disabled, "Appearance page")
  require(document.querySelector("h1")?.textContent === ((await appearance.get()).language === "zh-cmn-Hans-CN" ? "外观" : "Appearance"), "Appearance title must use selected language")

  if (phase === "change" && !theme && ligatures === undefined) {
    await select("language", "简体中文")
    await until(() => document.querySelector("h1")?.textContent === "外观", "Chinese translation")
    require(document.documentElement.lang === "zh-Hans-CN", "Document language must update")
    await selectTheme("dark")
    await until(() => !!terminal() && !!rows() && !!rows()!.textContent?.includes("==="), "Real terminal preview")
    require(!(await appearance.get()).terminalLigatures, "Terminal ligatures must default off")
    await font("interface", '"Segoe UI", "Microsoft YaHei", sans-serif')
    await font("terminal", '"Cascadia Code", "Noto Sans Mono CJK SC", monospace')
    await toggleLigatures(true)
    await toggleLigatures(false)
    await toggleLigatures(true)
  }
  if (theme) await selectTheme(theme)
  if (ligatures !== undefined) await toggleLigatures(ligatures)
  const settings = await appearance.get()
  await until(() => document.documentElement.style.colorScheme === (settings.theme === "system" ? "light dark" : settings.theme), "Applied color scheme")
  const interfaceFont = getComputedStyle(document.body).fontFamily
  await until(() => !!rows() && (settings.terminalLigatures ? joinedOperators().length > 0 : joinedOperators().length === 0), "Restored terminal rendering")
  const terminalFont = getComputedStyle(rows()!).fontFamily
  require(interfaceFont.includes('"Segoe UI"') && interfaceFont.includes('"Microsoft YaHei"') && interfaceFont.includes("sans-serif"), "Interface font CSS fallback must apply")
  require(terminalFont.includes('"Cascadia Code"') && terminalFont.includes('"Noto Sans Mono CJK SC"') && terminalFont.includes("monospace"), "Terminal font CSS fallback must apply")
  const preview = document.querySelector<HTMLElement>("[data-terminal-font-preview]")!.getBoundingClientRect()
  const screen = document.querySelector<HTMLElement>("[data-terminal-font-preview] .xterm-screen")!.getBoundingClientRect()
  require(screen.width > 0 && screen.height > 0 && screen.right <= preview.right + 1 && screen.bottom <= preview.bottom + 1, "Actual terminal must fit inside its preview")
  require(!document.querySelector('[role="alert"]'), "Appearance must not show a save error")
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  return { settings, background: getComputedStyle(document.body).backgroundColor, interfaceFont, terminalFont, terminalLigatures: settings.terminalLigatures, joinedOperators: joinedOperators(), language: document.documentElement.lang }
}

registerRendererScheme()
void app.whenReady().then(async () => {
  const argument = process.argv.find(value => value.startsWith("--appearance-smoke-context="))
  if (!argument) throw new Error("Missing appearance smoke context")
  const context = JSON.parse(argument.slice("--appearance-smoke-context=".length)) as AppearanceSmokeContext
  installRendererPermissions()
  protocol.handle(RENDERER_SCHEME, request => {
    const path = resolveRendererResourcePath(request.url, context.rendererDirectory)
    return request.method === "GET" && path ? net.fetch(pathToFileURL(path).toString()) : new Response(null, { status: 400 })
  })
  const controller = new AppearanceSettingsController(join(context.profileDirectory, "appearance.json"))
  installAppearance(controller)
  if (context.phase === "restore") {
    assert.equal(nativeTheme.themeSource, "dark", "Native theme must restore before window creation")
    assert.equal(getMainLocale(), "zh-cmn-Hans-CN", "Native language must restore before window creation")
  }
  const window = new BrowserWindow({
    show: false, width: 1200, height: 900,
    ...windowChromeOptions(process.platform),
    webPreferences: { preload: context.preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, additionalArguments: ["--deskfleet-locale=en-US"] },
  })
  attachAppearance(window)
  followSystemTheme(window, process.platform)
  process.on("message", () => app.quit())
  process.on("disconnect", () => app.quit())
  window.webContents.on("render-process-gone", (_event, details) => process.send?.({ error: `Renderer exited: ${details.reason}` }))
  await window.loadURL(`${BUNDLED_RENDERER_URL}#/settings`)
  const run = (theme?: "light" | "dark" | "system", ligatures?: boolean) => window.webContents.executeJavaScript(`(${exerciseAppearance.toString()})(${JSON.stringify(context.phase)}, ${JSON.stringify(theme)}, ${JSON.stringify(ligatures)})`) as Promise<Omit<AppearanceSmokeResult, "nativeTheme" | "screenshots">>
  const screenshots: string[] = []
  async function screenshot(name: string): Promise<void> {
    const path = join(context.outputDirectory, `${name}.png`)
    // Let the shared controls' color transitions and pending compositor frames settle.
    await new Promise(resolve => setTimeout(resolve, 250))
    // Hidden native windows can return a stale compositor frame. Await a fresh
    // offscreen paint after the DOM assertions, then save those actual pixels.
    const pixels = await new Promise<Buffer>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Appearance screenshot paint timed out")), 5_000)
      window.webContents.once("paint", (_event, _dirty, image) => { clearTimeout(timeout); resolve(image.toPNG()) })
      window.webContents.invalidate()
    })
    await writeFile(path, pixels)
    screenshots.push(path)
  }
  let result = await run()
  assert.equal(nativeTheme.themeSource, "dark")
  assert.equal(result.background, "rgb(23, 25, 31)")
  assert.equal(getMainLocale(), "zh-cmn-Hans-CN")
  await screenshot(context.phase === "change" ? "appearance-dark" : "appearance-restored")
  if (context.phase === "change") {
    await run(undefined, false)
    await screenshot("appearance-ligatures-disabled")
    await run(undefined, true)
    result = await run("light")
    assert.equal(nativeTheme.themeSource, "light")
    assert.equal(result.background, "rgb(251, 251, 253)")
    await screenshot("appearance-light")
    result = await run("system")
    assert.equal(nativeTheme.themeSource, "system")
    assert.equal(result.background, nativeTheme.shouldUseDarkColors ? "rgb(23, 25, 31)" : "rgb(251, 251, 253)")
    result = await run("dark")
    window.setSize(960, 700)
    await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    const overflow = await window.webContents.executeJavaScript(`document.documentElement.scrollWidth > document.documentElement.clientWidth`)
    assert.equal(overflow, false, "Appearance must fit the minimum window width")
    const terminalFits = await window.webContents.executeJavaScript(`(() => {
      const preview = document.querySelector('[data-terminal-font-preview]').getBoundingClientRect()
      const screen = document.querySelector('[data-terminal-font-preview] .xterm-screen').getBoundingClientRect()
      return screen.width > 0 && screen.right <= preview.right + 1 && screen.bottom <= preview.bottom + 1
    })()`)
    assert.equal(terminalFits, true, "The actual terminal must refit at minimum window width")
    await screenshot("appearance-minimum")
    await window.webContents.executeJavaScript(`document.querySelector('[data-terminal-font-preview]').parentElement.scrollIntoView({ block: 'end' })`)
    await screenshot("appearance-minimum-terminal")
  }
  process.send?.({ result: { ...result, nativeTheme: nativeTheme.themeSource, screenshots } satisfies AppearanceSmokeResult })
}).catch(error => { process.send?.({ error: String(error) }); app.quit() })
