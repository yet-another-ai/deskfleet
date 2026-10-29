import { app, BrowserWindow, net, powerSaveBlocker, protocol } from "electron"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { installCentralAccount } from "../../src/main/central-account.ts"
import { installLocalChannels } from "../../src/main/local-channels.ts"
import { attachDesktopMedia, installDesktopMediaIpc } from "../../src/main/desktop-media.ts"
import { attachSettings, installSettings, publishLocalAgentState } from "../../src/main/settings.ts"
import { LocalAgentController } from "../../src/main/local-agent-controller.ts"
import { OnboardingController } from "../../src/main/onboarding-controller.ts"
import { installOnboarding } from "../../src/main/onboarding.ts"
import { KeepAwakeController } from "../../src/main/keep-awake.ts"
import { NotificationSettingsController } from "../../src/main/notification-settings.ts"
import { WorktreeRootSettingsController } from "../../src/main/worktree-root-settings.ts"
import { createLocalAgentRuntime } from "../../src/main/local-agent-runtime.ts"
import { installRendererPermissions, registerRendererScheme, resolveRendererResourcePath } from "../../src/main/renderer-protocol.ts"
import { BUNDLED_RENDERER_URL, RENDERER_SCHEME } from "../../src/shared/renderer-security.ts"

export interface BackendClientsContext {
  mode: "web" | "electron"
  backend: string
  webUrl: string
  credentials: { email: string; password: string }
  rendererDirectory: string
  preloadPath: string
  daemonDirectory: string
  profileDirectory: string
  machines: string[]
  sessionId: string
  forceRelay: boolean
  teamId: string
  localProbePath: string
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
  function findButton(label: string, root: ParentNode = document): HTMLButtonElement | undefined {
    return [...root.querySelectorAll("button")].find(value => value.textContent?.trim() === label || value.getAttribute("aria-label") === label)
  }
  function button(label: string, root: ParentNode = document): HTMLButtonElement {
    const element = findButton(label, root)
    require(element, `Missing ${label} button: ${root instanceof Element ? root.outerHTML : document.body.innerText}`); return element
  }
  async function openSessionAction(label: string): Promise<HTMLButtonElement> {
    await until(() => {
      const trigger = findButton("Session actions")
      return !!trigger && !trigger.disabled && trigger.getAttribute("aria-disabled") !== "true"
    }, `${label} action enabled`)
    button("Session actions").click()
    let action: HTMLButtonElement | undefined
    await until(() => {
      const menu = document.querySelector('[role="menu"]')
      action = menu ? findButton(label, menu) : undefined
      return !!action
    }, `${label} menu item`)
    return action!
  }
  async function confirmSessionAction(label: string): Promise<void> {
    let confirmation: HTMLButtonElement | undefined
    await until(() => {
      const dialog = document.querySelector("[role=dialog][data-state=open]")
      confirmation = dialog ? findButton(label, dialog) : undefined
      return !!confirmation
    }, `${label} confirmation`)
    confirmation!.click()
  }
  // Unopened machines have a button; retained trees select their owner through resource links.
  const machineRow = (index: number) => document.querySelector<HTMLButtonElement>(`aside button[data-machine-id="${context.machines[index]}"]`)
  const machineTree = (index: number) => document.querySelector<HTMLElement>(`aside section[data-machine-id="${context.machines[index]}"]`)
  async function session(index: number): Promise<void> {
    const guard = (window as unknown as { __deskfleetRtcGuard: { blocked: boolean } }).__deskfleetRtcGuard
    guard.blocked = context.mode === "electron" && index === 0
    await until(() => !!machineTree(index) || !!machineRow(index), "team machines")
    machineRow(index)?.click()
    const link = () => machineTree(index)?.querySelector<HTMLAnchorElement>(`a[href="#/sessions/${context.sessionId}"]`)
    await until(() => !!link(), "machine session link")
    link()!.click()
    await until(() => !!document.querySelector("main")?.textContent?.includes(`Machine ${index} conversation`), "session route")
  }
  if (context.mode === "web") require(!("deskfleet" in window), "Web must not receive an Electron preload")
  else {
    const api = (window as unknown as { deskfleet: { central: { status(): Promise<{ serverUrl: string }> } } }).deskfleet
    const account = await api.central.status()
    require(account.serverUrl === context.backend, "The Electron client must use its compiled backend address")
    require(!JSON.stringify(account).includes('"token"'), "The Electron renderer must not receive the app session token")
  }
  if (offline) {
    await until(() => (machineRow(0) ?? machineTree(0))?.textContent?.includes("Offline") === true, "offline machine presence")
    await session(1)
    await session(0)
    await until(() => !!document.querySelector("main")?.textContent?.includes(`Prompt from ${context.mode}`), "offline synchronized history")
    require(!document.querySelector<HTMLButtonElement>('button[aria-label="Send"]') || document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled, "Offline history must disable live input")
    return { mode: context.mode, offline: true }
  }
  await session(0)
  await until(() => !!document.querySelector('textarea[aria-label="Prompt"]'), "session composer")
  await until(() => !document.querySelector("aside")?.textContent?.includes("Loading workspaces"), "initial workspace load")
  let flashedLoading = false
  const catalogObserver = new MutationObserver(() => {
    if (document.querySelector("aside")?.textContent?.includes("Loading workspaces")) flashedLoading = true
  })
  catalogObserver.observe(document.querySelector("aside")!, { subtree: true, childList: true, characterData: true })
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')!
  textarea.value = `Prompt from ${context.mode}`
  textarea.dispatchEvent(new Event("input", { bubbles: true }))
  await until(() => !button("Send").disabled, "authenticated Agent channel")
  button("Send").click()
  await until(() => !!document.querySelector("main")?.textContent?.includes("Fixture Agent is waiting for approval"), "streaming Agent message")
  await until(() => !!document.querySelector("main")?.textContent?.includes("Read fixture file"), "Agent tool call")
  const archive = await openSessionAction("Archive session")
  require(!document.body.innerText.includes("Delete session"), "Sessions must expose Archive, not Delete")
  archive.click()
  await confirmSessionAction("Archive session")
  await until(() => !!document.querySelector("main")?.textContent?.includes("This session is archived"), "archived state")
  const restore = await openSessionAction("Restore session")
  restore.click()
  await confirmSessionAction("Restore session")
  await until(() => !document.querySelector("[role=dialog][data-state=open]") && !document.querySelector("main")?.textContent?.includes("This session is archived"), "restore state")
  // The prompt and archive/restore publish real central catalog updates. Keep
  // observing beyond their coalescing timer to catch a transient loading title.
  await new Promise(resolve => setTimeout(resolve, 2_000))
  catalogObserver.disconnect()
  require(!flashedLoading, "Background catalog updates flashed the workspace loading title")
  await session(1)
  require(context.machines.every((_, index) => !!machineTree(index)?.querySelector('a[href*="/workspaces/"]')), "Switching machines must retain both expanded workspace trees")
  await until(() => !!document.querySelector('button[aria-label="Session actions"]'), "second machine conversation snapshot")
  require(!document.querySelector("main")!.textContent!.includes(`Prompt from ${context.mode}`), "Same local Session ID leaked across machines")
  await session(0)
  await until(() => !!document.querySelector("main")?.textContent?.includes(`Prompt from ${context.mode}`), "reattached conversation")
  return { mode: context.mode, offline: false }
}


type CaptureView = "session" | "workspace" | "team-menu" | "account-menu" | "settings-team" | "create-team" | "invite" | "add-machine"

/** Navigation stays within the disposable fixture's authenticated renderer. */
async function prepareCapture(context: BackendClientsContext, view: CaptureView): Promise<void> {
  async function until(predicate: () => boolean, description: string): Promise<void> {
    const end = Date.now() + 15_000
    while (!predicate()) {
      if (Date.now() > end) throw new Error(`Screenshot ${description} timed out: ${document.body.innerText}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  while (document.querySelector('[role=dialog][data-state=open]')) {
    const dialogs = [...document.querySelectorAll<HTMLElement>('[role=dialog][data-state=open]')]
    const dialog = dialogs.at(-1)!
    dialog.focus()
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    await until(() => !dialog.isConnected, "close dialog")
  }
  for (const trigger of document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"][aria-expanded="true"]')) trigger.click()
  location.hash = `/sessions/${context.sessionId}`
  await until(() => !!document.querySelector('button[aria-label="Team"]') && !!document.querySelector("main")?.textContent?.includes("Machine 0 conversation"), "session")
  if (view === "workspace") {
    const link = document.querySelector<HTMLAnchorElement>('aside a[href*="/workspaces/"]')
    if (!link) throw new Error("Fixture workspace link is missing")
    link.click()
    await until(() => location.hash.startsWith("#/workspaces/") && !!document.querySelector("main")?.textContent?.includes("Directories"), "workspace")
  } else if (view === "settings-team" || view === "invite") {
    document.querySelector<HTMLButtonElement>('button[aria-label="Team"]')!.click()
    await until(() => !!document.querySelector('[role="menu"][aria-label="Team"]'), "team menu")
    const manage = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find(button => button.textContent?.trim() === "Team settings")
    if (!manage) throw new Error("Team settings menu item is missing")
    manage.click()
    await until(() => location.hash === "#/team/settings" && !!document.querySelector("[data-member-id]"), "team settings")
    if (view === "invite") {
      const invite = [...document.querySelectorAll<HTMLButtonElement>("main button")].find(button => button.textContent?.trim() === "Invite")
      if (!invite) throw new Error("Invite button is missing")
      invite.click()
      await until(() => !!document.querySelector('[role=dialog][data-state=open] input[name="invite-email"]'), "invite dialog")
    }
  } else if (view === "create-team") {
    document.querySelector<HTMLButtonElement>('button[aria-label="Team"]')!.click()
    await until(() => !!document.querySelector('[role="menu"][aria-label="Team"]'), "team menu")
    const create = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find(button => button.textContent?.trim() === "Create a team")
    if (!create) throw new Error("Create a team menu item is missing")
    create.click()
    await until(() => !!document.querySelector("[role=dialog][data-state=open]")?.textContent?.includes("Create a team"), "create team dialog")
  } else if (view === "add-machine") {
    const add = document.querySelector<HTMLButtonElement>('aside button[aria-label="Add machine"]')
    if (!add) throw new Error("Add machine button is missing")
    add.click()
    await until(() => !!document.querySelector("[role=dialog][data-state=open]")?.textContent?.includes("Add a machine"), "add machine dialog")
  } else if (view.endsWith("-menu")) {
    const label = view === "team-menu" ? "Team" : "Client smoke"
    const trigger = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    if (!trigger) throw new Error(`Missing ${label} menu trigger`)
    trigger.click()
    await until(() => !!document.querySelector(`[role="menu"][aria-label="${label}"]`), label)
  }
  await document.fonts.ready
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

async function captureScreenshots(window: BrowserWindow, context: BackendClientsContext): Promise<void> {
  if (!process.env.DESKFLEET_SMOKE_SCREENSHOTS) return
  const directory = resolve(process.env.DESKFLEET_SMOKE_SCREENSHOTS)
  await mkdir(directory, { recursive: true })
  for (const [width, height] of [[1100, 740], [800, 600]] as const) {
    window.setContentSize(width, height)
    for (const view of ["session", "workspace", "team-menu", "account-menu", "settings-team", "create-team", "invite", "add-machine"] as const) {
      await window.webContents.executeJavaScript(`(${prepareCapture.toString()})(${JSON.stringify(context)},${JSON.stringify(view)})`)
      const image = await window.webContents.capturePage()
      if (image.isEmpty()) throw new Error(`Empty screenshot for ${context.mode} ${view}`)
      await writeFile(join(directory, `${context.mode}-${width}x${height}-${view}.png`), image.toPNG())
    }
  }
  await window.webContents.executeJavaScript(`(${prepareCapture.toString()})(${JSON.stringify(context)},"session")`)
  window.setContentSize(1440, 950)
  process.stderr.write(`${context.mode} UI screenshots saved to ${directory}\n`)
}

async function openTerminal(machineId: string, local: boolean): Promise<void> {
  location.hash = `/machines/${machineId}/control?tab=terminal`
  const deadline = Date.now() + 30_000
  async function until(predicate: () => boolean): Promise<void> {
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Terminal UI timed out: ${document.body.innerText}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  const label = local ? "Local control" : "Remote control"
  const tools = () => document.querySelector(`[role="tablist"][aria-label="${label}"]`)
  await until(() => tools()?.querySelector('[aria-selected="true"]')?.textContent?.trim() === "Terminal")
  const desktop = [...tools()!.querySelectorAll('[role="tab"]')].some(tab => tab.textContent?.trim() === "Desktop")
  if (desktop === local) throw new Error(local ? "Local controls must hide Desktop" : "Remote controls must retain Desktop")
  await until(() => !!document.querySelector('button[aria-label="New shell"]'))
  document.querySelector<HTMLButtonElement>('button[aria-label="New shell"]')!.click()
  await until(() => !!document.querySelector('[data-connection="connected"]'))
  const terminalId = new URLSearchParams(location.hash.split("?", 2)[1]).get("terminal")
  if (!terminalId || document.querySelector(`[role="tab"][data-terminal-id="${terminalId}"]`)?.getAttribute("aria-selected") !== "true") throw new Error("Control route did not select the new terminal")
  await until(() => !!document.querySelector(".xterm-rows")?.textContent?.trim())
  // A login shell can finish its startup repaint after the peer's replay marker.
  await new Promise(resolve => setTimeout(resolve, 300))
  document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!.focus()
}

/** Enter fixture credentials through the real account form, then approve native login. */
async function authenticateWindow(window: BrowserWindow, context: BackendClientsContext, approve: boolean): Promise<void> {
  const deadline = Date.now() + 30_000
  let submitted = false
  while (Date.now() < deadline) {
    const page = await window.webContents.executeJavaScript(`({email:!!document.querySelector('input[type="email"]'),form:!!document.querySelector('form'),app:!!document.querySelector('button[aria-label="Team"]')})`).catch(() => undefined) as { email: boolean; form: boolean; app: boolean } | undefined
    if (page?.email && !submitted) {
      await window.webContents.executeJavaScript(`(()=>{const values=${JSON.stringify(context.credentials)};for(const type of ["email","password"]){const value=values[type];const input=document.querySelector('input[type="'+type+'"]');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('form').requestSubmit();})()`)
      submitted = true
    } else if (page && !page.email && page.form && approve) {
      await window.webContents.executeJavaScript("document.querySelector('form').requestSubmit()")
      return
    } else if (page?.app || (submitted && page && !page.email && !approve)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Account sign-in timed out: ${await window.webContents.executeJavaScript("document.body.innerText")}`)
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
  installRendererPermissions()
  const authorizations: BrowserWindow[] = []
  let controller: LocalAgentController | undefined
  let keepAwake: KeepAwakeController | undefined
  let localChannels: ReturnType<typeof installLocalChannels> | undefined
  if (context.mode === "electron") {
    installDesktopMediaIpc()
    controller = new LocalAgentController(join(context.profileDirectory, "settings.json"), createLocalAgentRuntime({ directory: context.daemonDirectory }), publishLocalAgentState)
    keepAwake = new KeepAwakeController(join(context.profileDirectory, "keep-awake.json"), powerSaveBlocker)
    installSettings(controller, keepAwake, new NotificationSettingsController(join(app.getPath("userData"), "notifications.json")), new WorktreeRootSettingsController(context.daemonDirectory))
    keepAwake.get()
    await controller.initialize()
    const central = await installCentralAccount({ openAuthorization: async url => {
      const browser = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      authorizations.push(browser)
      browser.webContents.on("console-message", (event) => { if (event.level === "error") process.stderr.write(`${event.message}\n`) })
      await browser.loadURL(url)
      await authenticateWindow(browser, context, true)
    } })
    localChannels = installLocalChannels(central)
    // This fixture exercises signed-in clients; smoke-startup covers first-run setup.
    const onboardingPath = join(context.profileDirectory, "onboarding.json")
    await writeFile(onboardingPath, JSON.stringify({ step: "complete" }))
    installOnboarding(new OnboardingController({ path: onboardingPath, platform: process.platform, localAgent: controller }))
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
  await window.webContents.debugger.sendCommand("Page.enable")
  // Use xterm's supported DOM fallback so PTY output is observable without canvas OCR.
  const domTerminal = "const nativeContext=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return /^webgl2?$/.test(type)?null:nativeContext.call(this,type,...args)};"
  await window.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: `Object.defineProperty(navigator,'languages',{get:()=>['en-US']});${domTerminal}window.__deskfleetRtcGuard={blocked:${context.mode === "electron"},forbiddenAttempts:0,connections:0};const NativePeer=window.RTCPeerConnection;window.RTCPeerConnection=class extends NativePeer{constructor(config){const guard=window.__deskfleetRtcGuard;if(guard.blocked){guard.forbiddenAttempts++;throw new Error('WebRTC is disabled for the local channel smoke');}super(${context.forceRelay ? "{...config,iceTransportPolicy:'relay'}" : "config"});guard.connections++;}};` })
  await window.loadURL(context.mode === "web" ? context.webUrl : BUNDLED_RENDERER_URL)
  await window.webContents.executeJavaScript(`(async () => { const end=Date.now()+15000; while(!document.querySelector('form button[type="submit"]:not(:disabled)')) { [...document.querySelectorAll('button')].find(button => button.textContent === 'Skip for now')?.click(); if(Date.now()>end)throw new Error('Login form unavailable at '+location.href+': '+document.body.innerText);await new Promise(r=>setTimeout(r,25)); } })()`)
  await window.webContents.executeJavaScript(`(() => { if(document.querySelector('input[name="server-url"]'))throw new Error('Backend configuration must not be exposed in the UI');document.querySelector('form').requestSubmit(); })()`)
  if (context.mode === "web") await authenticateWindow(window, context, false)
  // Wait from the main process while authentication replaces the Web document.
  const deadline = Date.now() + 30_000
  while (!await window.webContents.executeJavaScript(`!!document.querySelector('button[aria-label="Team"]') && !!document.querySelector('aside nav')`).catch(() => false)) {
    if (Date.now() > deadline) throw new Error(`Account login timed out: ${await window.webContents.executeJavaScript("document.body.innerText")}; authorization: ${await Promise.all(authorizations.map(browser => browser.webContents.executeJavaScript("location.href+' '+document.body.innerText")))}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const result = await window.webContents.executeJavaScript(`(${exercise.toString()})(${JSON.stringify(context)})`)
  if (context.mode === "electron") {
    const probe = await readFile(context.localProbePath, "utf8")
    result.localChannels = await window.webContents.executeJavaScript(`${probe}\nlocalChannelSmoke.exercise(${JSON.stringify({ teamId: context.teamId, machineId: context.machines[0], sessionId: context.sessionId })})`)
  }
  await captureScreenshots(window, context)
  await window.webContents.executeJavaScript(`(${openTerminal.toString()})(${JSON.stringify(context.machines[0])},${context.mode === "electron"})`)
  const terminalTitle = `DF_${context.mode}_REMOTE_PTY`
  const command = process.platform === "win32" ? `powershell -NoProfile -Command "Write-Output ('DF_' + '${context.mode}' + '_REMOTE_PTY')"` : `printf 'DF_%s_REMOTE_PTY\\n' ${context.mode}`
  await window.webContents.executeJavaScript(`(()=>{const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(command)});document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`)
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" })
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" })
  await window.webContents.executeJavaScript(`(async()=>{const end=Date.now()+20000;while(!document.querySelector('.xterm-rows')?.textContent.includes(${JSON.stringify(terminalTitle)})){if(Date.now()>end)throw new Error('Terminal PTY output did not return: '+document.body.innerText);await new Promise(r=>setTimeout(r,25));}if(window.__deskfleetRtcGuard.forbiddenAttempts)throw new Error('Local interaction attempted WebRTC');})()`)
  process.send?.({ phase: "online", result })
  const exit = () => { void Promise.all([localChannels?.close(), controller?.close()]).finally(() => { keepAwake?.close(); app.exit(0) }) }
  process.on("message", message => {
    if (message && typeof message === "object" && "offline" in message) {
      void window.webContents.executeJavaScript(`(${exercise.toString()})(${JSON.stringify(context)},true)`).then(result => process.send?.({ result }), error => process.send?.({ error: String(error) }))
    } else {
      for (const browser of authorizations) browser.destroy()
      window.destroy()
      exit()
    }
  })
  process.on("disconnect", exit)
}).catch(error => { process.send?.({ error: String(error) }); app.exit(1) })
