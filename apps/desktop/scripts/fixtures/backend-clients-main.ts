import { app, BrowserWindow, net, protocol } from "electron"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { installCentralAccount } from "../../src/main/central-account.ts"
import { attachDesktopMedia, installDesktopMediaIpc } from "../../src/main/desktop-media.ts"
import { attachSettings, installSettings, publishLocalAgentState } from "../../src/main/settings.ts"
import { LocalAgentController } from "../../src/main/local-agent-controller.ts"
import { createLocalAgentRuntime } from "../../src/main/local-agent-runtime.ts"
import { denyChromiumPermissions, registerRendererScheme, resolveRendererResourcePath } from "../../src/main/renderer-protocol.ts"
import { BUNDLED_RENDERER_URL, RENDERER_SCHEME } from "../../src/shared/renderer-security.ts"

export interface BackendClientsContext {
  mode: "web" | "electron"
  backend: string
  webUrl: string
  rendererDirectory: string
  preloadPath: string
  daemonDirectory: string
  profileDirectory: string
  machines: string[]
  sessionId: string
  forceRelay: boolean
}

/** Operates the shipped shared Vue UI; no application APIs or stores are replaced. */
async function exercise(context: BackendClientsContext, offline = false): Promise<{ mode: string; offline: boolean }> {
  function require(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
  async function until(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 30_000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`${description} timed out: ${document.body.innerText.slice(-4_000)}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  function button(label: string, root: ParentNode = document): HTMLButtonElement {
    const element = [...root.querySelectorAll("button")].find(value => value.textContent?.trim() === label || value.getAttribute("aria-label") === label)
    require(element, `Missing ${label} button`); return element
  }
  function selectMachine(index: number): void {
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Machine"]')!
    select.value = context.machines[index]!
    select.dispatchEvent(new Event("change", { bubbles: true }))
  }
  async function session(index: number): Promise<void> {
    await until(() => !!document.querySelector('select[aria-label="Machine"]'), "machine selector")
    selectMachine(index)
    await until(() => !!document.querySelector("aside")?.textContent?.includes(`Machine ${index}`), "machine catalog")
    location.hash = `/sessions/${context.sessionId}`
    await until(() => !!document.querySelector("main")?.textContent?.includes(`Machine ${index} conversation`), "session route")
  }
  if (context.mode === "web") require(!("deskfleet" in window), "Web must not receive an Electron preload")
  else {
    const api = (window as unknown as { deskfleet: { central: { status(): Promise<unknown> } } }).deskfleet
    require(!JSON.stringify(await api.central.status()).includes('"token"'), "The Electron renderer must not receive the app session token")
  }
  if (offline) {
    await until(() => !!document.querySelector(`option[value="${context.machines[0]}"]`)?.textContent?.includes("Offline"), "offline machine presence")
    await session(1)
    await session(0)
    await until(() => !!document.querySelector("main")?.textContent?.includes(`Prompt from ${context.mode}`), "offline synchronized history")
    require(!document.querySelector<HTMLButtonElement>('button[aria-label="Send"]') || document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled, "Offline history must disable live input")
    return { mode: context.mode, offline: true }
  }
  await session(0)
  await until(() => !!document.querySelector('textarea[aria-label="Prompt"]'), "session composer")
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')!
  textarea.value = `Prompt from ${context.mode}`
  textarea.dispatchEvent(new Event("input", { bubbles: true }))
  await until(() => !button("Send").disabled, "authenticated Agent WebRTC peer")
  button("Send").click()
  await until(() => !!document.querySelector("main")?.textContent?.includes("Fixture Agent is waiting for approval"), "streaming Agent message")
  await until(() => !!document.querySelector("main")?.textContent?.includes("Read fixture file"), "Agent tool call")
  button("Session actions").click()
  await until(() => !!document.querySelector('[role="menu"]'), "session actions menu")
  require(!document.body.innerText.includes("Delete session"), "Sessions must expose Archive, not Delete")
  button("Archive session", document.querySelector('[role="menu"]')!).click()
  await until(() => !!document.querySelector("dialog[open]"), "archive confirmation")
  button("Archive session", document.querySelector("dialog[open]")!).click()
  await until(() => !!document.querySelector("main")?.textContent?.includes("This session is archived"), "archived state")
  await until(() => !button("Session actions").disabled, "archive command completed")
  await new Promise(resolve => setTimeout(resolve, 50))
  button("Session actions").click()
  await until(() => !!document.querySelector('[role="menu"]'), `restoration menu ${button("Session actions").outerHTML}`)
  button("Restore session", document.querySelector('[role="menu"]')!).click()
  await until(() => !!document.querySelector("dialog[open]"), "restore confirmation")
  button("Restore session", document.querySelector("dialog[open]")!).click()
  await until(() => !document.querySelector("dialog[open]") && !document.querySelector("main")?.textContent?.includes("This session is archived"), "restore state")
  await session(1)
  await until(() => !!document.querySelector('button[aria-label="Session actions"]'), "second machine conversation snapshot")
  require(!document.querySelector("main")!.textContent!.includes(`Prompt from ${context.mode}`), "Same local Session ID leaked across machines")
  await session(0)
  await until(() => !!document.querySelector("main")?.textContent?.includes(`Prompt from ${context.mode}`), "reattached conversation")
  return { mode: context.mode, offline: false }
}

async function openTerminal(machineId: string): Promise<void> {
  location.hash = `/machines/${machineId}/terminals`
  const deadline = Date.now() + 30_000
  async function until(predicate: () => boolean): Promise<void> {
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Terminal UI timed out: ${document.body.innerText}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  await until(() => !!document.querySelector('button[aria-label="New shell"]'))
  document.querySelector<HTMLButtonElement>('button[aria-label="New shell"]')!.click()
  await until(() => !!document.querySelector('[data-connection="connected"]'))
  await until(() => !!document.querySelector(".xterm-rows")?.textContent?.trim())
  // A login shell can finish its startup repaint after the peer's replay marker.
  await new Promise(resolve => setTimeout(resolve, 300))
  document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!.focus()
}

const argument = process.argv.find(value => value.startsWith("--backend-client-context="))
if (!argument) throw new Error("Missing backend client context")
const context = JSON.parse(argument.slice("--backend-client-context=".length)) as BackendClientsContext
app.setPath("userData", context.profileDirectory)
app.setPath("sessionData", context.profileDirectory)
app.commandLine.appendSwitch("lang", "en-US")
registerRendererScheme()
app.on("window-all-closed", () => {})

void app.whenReady().then(async () => {
  denyChromiumPermissions()
  const authorizations: BrowserWindow[] = []
  let controller: LocalAgentController | undefined
  if (context.mode === "electron") {
    installDesktopMediaIpc()
    controller = new LocalAgentController(join(context.profileDirectory, "settings.json"), createLocalAgentRuntime({ directory: context.daemonDirectory }), publishLocalAgentState)
    installSettings(controller)
    await controller.initialize()
    await installCentralAccount({ openAuthorization: async url => {
      const browser = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      authorizations.push(browser)
      browser.webContents.on("console-message", (event) => { if (event.level === "error") process.stderr.write(`${event.message}\n`) })
      await browser.loadURL(url)
    } })
    protocol.handle(RENDERER_SCHEME, request => {
      const path = resolveRendererResourcePath(request.url, context.rendererDirectory)
      return path ? net.fetch(pathToFileURL(path).toString()) : new Response(null, { status: 400 })
    })
  }
  const window = new BrowserWindow({ show: false, width: 1440, height: 950, webPreferences: {
    ...(context.mode === "electron" ? { preload: context.preloadPath } : {}),
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    additionalArguments: ["--deskfleet-locale=en-US"],
  } })
  if (context.mode === "electron") { attachDesktopMedia(window); attachSettings(window) }
  window.webContents.on("console-message", event => { if (event.level === "error") process.stderr.write(`${event.message}\n`) })
  window.webContents.on("render-process-gone", (_event, details) => { process.send?.({ error: `Renderer exited: ${details.reason}` }); app.exit(1) })
  // Force TURN at the native browser boundary, leaving the app's signaling and ICE servers untouched.
  await window.loadURL("about:blank")
  window.webContents.debugger.attach("1.3")
  await window.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: `Object.defineProperty(navigator,'languages',{get:()=>['en-US']});${context.forceRelay ? "const NativePeer=window.RTCPeerConnection;window.RTCPeerConnection=class extends NativePeer{constructor(config){super({...config,iceTransportPolicy:'relay'})}};" : ""}` })
  await window.loadURL(context.mode === "web" ? context.webUrl : BUNDLED_RENDERER_URL)
  await window.webContents.executeJavaScript(`(async () => { const end=Date.now()+15000; while(!document.querySelector('input[type="url"]:not(:disabled)')) { if(Date.now()>end)throw new Error('Login form unavailable: '+document.body.innerText);await new Promise(r=>setTimeout(r,25)); } })()`)
  await window.webContents.executeJavaScript(`(() => { const input=document.querySelector('input[type="url"]');input.value=${JSON.stringify(context.backend)};input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit(); })()`)
  // The Web login replaces the document twice. Wait from the main process for the app to return.
  const deadline = Date.now() + 30_000
  while (!await window.webContents.executeJavaScript(`!!document.querySelector('select[aria-label="Machine"]')`).catch(() => false)) {
    if (Date.now() > deadline) throw new Error(`OIDC login timed out: ${await window.webContents.executeJavaScript("document.body.innerText")}; authorization: ${await Promise.all(authorizations.map(browser => browser.webContents.executeJavaScript("location.href+' '+document.body.innerText")))}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const result = await window.webContents.executeJavaScript(`(${exercise.toString()})(${JSON.stringify(context)})`)
  await window.webContents.executeJavaScript(`(${openTerminal.toString()})(${JSON.stringify(context.machines[0])})`)
  const terminalTitle = `DF_${context.mode}_REMOTE_PTY`
  const command = process.platform === "win32" ? `powershell -NoProfile -Command "Write-Output ('DF_' + '${context.mode}' + '_REMOTE_PTY')"` : `printf 'DF_%s_REMOTE_PTY\\n' ${context.mode}`
  await window.webContents.executeJavaScript(`(()=>{const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(command)});document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`)
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" })
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" })
  await window.webContents.executeJavaScript(`(async()=>{const end=Date.now()+20000;while(!document.querySelector('.xterm-rows')?.textContent.includes(${JSON.stringify(terminalTitle)})){if(Date.now()>end)throw new Error('Terminal PTY output did not return over WebRTC: '+document.body.innerText);await new Promise(r=>setTimeout(r,25));}})()`)
  process.send?.({ phase: "online", result })
  process.on("message", message => {
    if (message && typeof message === "object" && "offline" in message) {
      void window.webContents.executeJavaScript(`(${exercise.toString()})(${JSON.stringify(context)},true)`).then(result => process.send?.({ result }), error => process.send?.({ error: String(error) }))
    } else {
      for (const browser of authorizations) browser.destroy()
      window.destroy(); void controller?.close().finally(() => app.exit(0)); if (!controller) app.exit(0)
    }
  })
  process.on("disconnect", () => app.exit(0))
}).catch(error => { process.send?.({ error: String(error) }); app.exit(1) })
