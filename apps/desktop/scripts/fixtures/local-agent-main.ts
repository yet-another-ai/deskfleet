import { app, BrowserWindow, net, powerSaveBlocker, protocol } from "electron"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { startDaemon } from "@deskfleet/daemon"
import { configureAdapterHost } from "@deskfleet/daemon/adapters"
import { DaemonClient } from "@deskfleet/daemon/control-client"
import { readDaemonDiscovery } from "@deskfleet/daemon/control-discovery"
import { attachDesktopMedia, installDesktopMediaIpc } from "../../src/main/desktop-media.ts"
import { keepRunningInBackground } from "../../src/main/lifecycle.ts"
import { KeepAwakeController } from "../../src/main/keep-awake.ts"
import { NotificationSettingsController } from "../../src/main/notification-settings.ts"
import { WorktreeRootSettingsController } from "../../src/main/worktree-root-settings.ts"
import { LocalAgentController } from "../../src/main/local-agent-controller.ts"
import { createLocalAgentRuntime } from "../../src/main/local-agent-runtime.ts"
import { attachSettings, installSettings, publishLocalAgentState } from "../../src/main/settings.ts"
import { denyChromiumPermissions, registerRendererScheme, resolveRendererResourcePath } from "../../src/main/renderer-protocol.ts"
import { BUNDLED_RENDERER_URL, RENDERER_SCHEME } from "../../src/shared/renderer-security.ts"
import type { DeskfleetDesktopApi } from "../../../../packages/client/src/desktop-api.ts"

export interface LocalAgentSmokeContext {
  phase: "start" | "restart" | "disabled" | "external"
  rendererDirectory: string
  preloadPath: string
  /** The built app entry, which routes bundled ACP adapter arguments. */
  mainEntry: string
  profileDirectory: string
  daemonDirectory: string
  checkoutPath: string
  workspaceId?: string
  terminalId?: string
  providerId?: string
}

export interface LocalAgentSmokeResult {
  workspaceId?: string
  terminalId?: string
  stoppedTerminalId?: string
  providerId?: string
  daemonIdentity?: string
  /** Whether the hosted daemon kept serving after the last window closed. */
  survivedWindowClose?: boolean
}

// Executes inside the built Vapor renderer with the production preload bridge.
async function exerciseSettings(context: LocalAgentSmokeContext): Promise<LocalAgentSmokeResult> {
  const api = (window as unknown as { deskfleet: DeskfleetDesktopApi }).deskfleet
  function require(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
  }
  async function until(predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
    const deadline = Date.now() + 20_000
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error(`${description} timed out; renderer: ${document.body.innerText.slice(-3_000)}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  const toggle = () => document.querySelector<HTMLButtonElement>('main [role="switch"][aria-labelledby="local-agent-label"]')
  const keepAwakeToggle = () => document.querySelector<HTMLButtonElement>('main [role="switch"][aria-labelledby="keep-awake-label"]')
  const settingsButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')
  const addWorkspace = () => document.querySelector<HTMLButtonElement>('button[aria-label="Add workspace"]')
  const sidebarWorkspace = () => [...document.querySelectorAll("aside a")].some(link => link.textContent?.trim() === "Local Agent smoke")
  // Settings replaces the sidebar, so sidebar checks happen after returning to the app.
  async function openSettings(): Promise<void> {
    settingsButton()!.click()
    await until(() => !!toggle() && !toggle()!.disabled && !!keepAwakeToggle() && !keepAwakeToggle()!.disabled, "Settings page")
  }
  async function leaveSettings(): Promise<void> {
    [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === "Back to app")!.click()
    await until(() => !!settingsButton(), "Return from Settings")
  }
  async function verifyNotifications(): Promise<void> {
    const link = [...document.querySelectorAll("nav a")].find(link => link.textContent?.trim() === "Notifications") as HTMLAnchorElement | undefined
    require(link, "Missing Notifications settings section")
    link.click()
    const switchFor = (key: string) => document.querySelector<HTMLButtonElement>(`[aria-labelledby="notifications-${key}-label"]`)!
    await until(() => !!switchFor("enabled") && !switchFor("enabled").disabled, "Notification preferences")
    if (context.phase === "start") {
      require(["enabled", "taskCompleted", "taskNeedsInput"].every(key => switchFor(key).getAttribute("aria-checked") === "true"), "Notifications must default on")
      switchFor("taskCompleted").click()
      await until(() => !switchFor("enabled").disabled && switchFor("taskCompleted").getAttribute("aria-checked") === "false", "Saved completion preference")
      switchFor("enabled").click()
      await until(() => !switchFor("enabled").disabled && switchFor("enabled").getAttribute("aria-checked") === "false", "Saved overall preference")
      require(switchFor("taskCompleted").disabled && switchFor("taskNeedsInput").disabled, "Overall preference must disable category switches")
    } else {
      require(switchFor("enabled").getAttribute("aria-checked") === "false", "Overall notification preference must survive restart")
      switchFor("enabled").click()
      await until(() => !switchFor("taskCompleted").disabled, "Re-enabled notifications")
    }
    const saved = await api.settings.getNotifications()
    require(saved.enabled === (context.phase !== "start") && !saved.taskCompleted && saved.taskNeedsInput, "Notification choices must persist independently")
    await leaveSettings()
    await openSettings()
  }
  async function verifyDeniedPermission(): Promise<void> {
    await until(() => !!document.querySelector('[data-screen-capture-permission="denied"]'), "Screen permission denial")
    await until(() => !!document.querySelector('[data-accessibility-permission="denied"]'), "Accessibility permission denial")
    const state = await api.settings.get()
    require(state.status === "running" && state.screenCapturePermission?.status === "denied" && state.accessibilityPermission?.status === "denied", "Denied desktop permissions must leave the Agent running")
    require([...document.querySelectorAll('main [role="status"]')].some(element => element.textContent?.trim() === "Running"), "Settings must show Running while screen access is denied")
    require(document.querySelector('[data-screen-capture-permission="denied"]')!.getAttribute("role") === "alert", "Denied permission must be visible in Settings")
    require(document.querySelector('[data-desktop-permissions] [data-accessibility-permission="denied"]')!.getAttribute("role") === "alert", "Accessibility denial must appear with screen permission in Settings")
  }
  function button(text: string, root: ParentNode = document): HTMLButtonElement {
    const element = [...root.querySelectorAll("button")].find(button => button.textContent?.trim() === text)
    require(element, `Missing ${text} button`)
    return element
  }
  function input(selector: string, value: string): void {
    const element = document.querySelector<HTMLInputElement>(selector)
    require(element, `Missing ${selector} input`)
    element.value = value
    element.dispatchEvent(new Event("input", { bubbles: true }))
  }
  async function openProviders(): Promise<void> {
    const link = [...document.querySelectorAll("nav a")].find(link => link.textContent?.trim() === "Agents") as HTMLAnchorElement | undefined
    require(link, "Missing Agents settings section")
    link.click()
    await until(() => [...document.querySelectorAll("button")].some(button => button.textContent?.trim() === "Add provider" && !button.disabled), "Provider settings")
  }
  async function addProvider(): Promise<HTMLDialogElement> {
    button("Add provider").click()
    await until(() => !!document.querySelector('dialog[open] input[name="provider-name"]'), "Add provider dialog")
    return document.querySelector<HTMLDialogElement>("dialog[open]")!
  }
  async function saveProvider(dialog: HTMLDialogElement): Promise<void> {
    dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
    await until(() => !document.querySelector("dialog[open]"), "Saved provider")
  }
  async function chooseProviderIcon(dialog: HTMLDialogElement, icon: string): Promise<void> {
    const trigger = dialog.querySelector<HTMLButtonElement>("button[aria-expanded]")
    require(trigger && dialog.querySelector(`label[for="${trigger.id}"]`)?.textContent?.trim() === "Icon", "Missing provider icon picker")
    trigger.click()
    await until(() => trigger.getAttribute("aria-expanded") === "true" && !!dialog.querySelector('[name="provider-icon-search"]'), "Provider icon choices")
    input('[name="provider-icon-search"]', icon)
    await until(() => !!dialog.querySelector(`[data-provider-icon-choice="${icon}"]`) && [...dialog.querySelectorAll("[data-provider-icon-choice]")].every(choice => choice.getAttribute("data-provider-icon-choice")!.includes(icon)), "Filtered provider icon")
    dialog.querySelector<HTMLButtonElement>(`[data-provider-icon-choice="${icon}"]`)!.click()
    await until(() => trigger.getAttribute("aria-expanded") === "false" && !!trigger.querySelector(`[data-provider-icon="${icon}"]`), "Selected provider icon")
  }
  async function providerAction(id: string, action: string): Promise<void> {
    const row = document.querySelector(`[data-provider-id="${id}"]`)
    require(row, "Provider was not rendered")
    row.querySelector<HTMLButtonElement>("button")!.click()
    await until(() => !!row.querySelector('[role="menu"]'), "Provider actions")
    button(action, row).click()
    await until(() => !!document.querySelector("dialog[open]"), `${action} dialog`)
  }
  async function removeProvider(id: string): Promise<void> {
    await providerAction(id, "Remove provider")
    button("Remove provider", document.querySelector("dialog[open]")!).click()
    await until(() => !document.querySelector("dialog[open]") && !document.querySelector(`[data-provider-id="${id}"]`), "Removed provider")
    require(!(await api.providers.list()).providers.some(provider => provider.id === id), "Provider removal was not persisted")
  }
  async function exerciseProviders(): Promise<string> {
    await openProviders()
    let dialog = await addProvider()
    const template = dialog.querySelector<HTMLSelectElement>("#provider-template")!
    require(template.value === "codex", "New providers must offer the Codex template")
    require(dialog.querySelector<HTMLInputElement>('[name="provider-binary"]')?.placeholder === "codex", "Blank Codex paths must show the default executable")
    input('[name="provider-name"]', "Work Codex")
    await chooseProviderIcon(dialog, "deepseek")
    button("Add variable", dialog).click()
    await until(() => !!dialog.querySelector("[data-environment-row]"), "Environment row")
    input('[data-environment-row] input:first-child', "DESKFLEET_SMOKE_PROFILE")
    input('[data-environment-row] input:nth-child(2)', "work")
    await saveProvider(dialog)
    const created = (await api.providers.list()).providers.find(provider => provider.name === "Work Codex")
    require(created?.template === "codex" && created.icon === "deepseek" && created.binaryPath === undefined && created.env.DESKFLEET_SMOKE_PROFILE === "work", "Provider creation did not retain its template, icon, default path, and environment")
    require(document.querySelector(`[data-provider-id="${created.id}"] [data-provider-icon="deepseek"]`), "Created provider did not display its selected icon")
    await providerAction(created.id, "Edit provider")
    dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!
    const fixedTemplate = dialog.querySelector<HTMLInputElement>("#provider-template")
    require(fixedTemplate?.readOnly && fixedTemplate.value === "Codex" && !dialog.querySelector("select#provider-template"), "Existing provider templates must not be editable")
    await chooseProviderIcon(dialog, "claude")
    input('[name="provider-name"]', "Work Codex updated")
    input('[name="provider-binary"]', `${context.checkoutPath}/custom-codex`)
    // The bundled Codex adapter starts in Electron's Node mode and reports the missing CLI.
    button("Test", dialog).click()
    await until(() => dialog.querySelector('[data-provider-test-result][role="alert"]')?.textContent?.includes("custom-codex") ?? false, "Failed provider test")
    require((await api.providers.list()).providers.find(provider => provider.id === created.id)?.binaryPath === undefined, "Testing a provider must not save its settings")
    input('[data-environment-row] input:nth-child(2)', "updated")
    await saveProvider(dialog)
    const edited = (await api.providers.list()).providers.find(provider => provider.id === created.id)
    require(edited?.template === "codex" && edited.icon === "claude" && edited.name === "Work Codex updated" && edited.binaryPath === `${context.checkoutPath}/custom-codex` && edited.env.DESKFLEET_SMOKE_PROFILE === "updated", "Provider edits were not persisted")
    require(document.querySelector(`[data-provider-id="${created.id}"] [data-provider-icon="claude"]`), "Edited provider did not display its updated icon")
    dialog = await addProvider()
    const cursor = dialog.querySelector<HTMLSelectElement>("#provider-template")!
    cursor.value = "cursor"
    cursor.dispatchEvent(new Event("change", { bubbles: true }))
    await until(() => dialog.querySelector<HTMLInputElement>('[name="provider-binary"]')?.placeholder === "agent"
      && dialog.querySelector("[data-provider-icon]")?.getAttribute("data-provider-icon") === "cursor"
      && (dialog.textContent?.includes("agent acp") ?? false), "Cursor template defaults")
    input('[name="provider-name"]', "Temporary Cursor")
    await saveProvider(dialog)
    const cursorProvider = (await api.providers.list()).providers.find(provider => provider.name === "Temporary Cursor")
    require(cursorProvider?.template === "cursor" && cursorProvider.binaryPath === undefined, "Cursor provider template was not saved")
    require(document.querySelector(`[data-provider-id="${cursorProvider.id}"] [data-provider-icon="cursor"]`), "Cursor provider did not display its template icon")
    await removeProvider(cursorProvider.id)
    dialog = await addProvider()
    const grok = dialog.querySelector<HTMLSelectElement>("#provider-template")!
    grok.value = "grok"
    grok.dispatchEvent(new Event("change", { bubbles: true }))
    await until(() => dialog.querySelector<HTMLInputElement>('[name="provider-binary"]')?.placeholder === "grok"
      && dialog.querySelector("[data-provider-icon]")?.getAttribute("data-provider-icon") === "grok"
      && (dialog.textContent?.includes("grok agent stdio") ?? false), "Grok template defaults")
    input('[name="provider-name"]', "Temporary Grok")
    await saveProvider(dialog)
    const grokProvider = (await api.providers.list()).providers.find(provider => provider.name === "Temporary Grok")
    require(grokProvider?.template === "grok" && grokProvider.binaryPath === undefined, "Grok provider template was not saved")
    require(document.querySelector(`[data-provider-id="${grokProvider.id}"] [data-provider-icon="grok"]`), "Grok provider did not display its template icon")
    await removeProvider(grokProvider.id)
    dialog = await addProvider()
    const acp = dialog.querySelector<HTMLSelectElement>("#provider-template")!
    acp.value = "acp"
    acp.dispatchEvent(new Event("change", { bubbles: true }))
    await until(() => dialog.querySelector<HTMLInputElement>('[name="provider-binary"]')?.placeholder === "acp-agent", "ACP template defaults")
    input('[name="provider-name"]', "Temporary ACP")
    await saveProvider(dialog)
    const temporary = (await api.providers.list()).providers.find(provider => provider.name === "Temporary ACP")
    require(temporary?.template === "acp", "ACP provider template was not saved")
    await removeProvider(temporary.id)
    return created.id
  }
  async function change(enabled: boolean): Promise<void> {
    await openSettings()
    require(toggle()!.getAttribute("aria-checked") === String(!enabled), "Switch preference did not match the previous state")
    toggle()!.click()
    await until(async () => {
      const state = await api.settings.get()
      if (state.status === "error") throw new Error(state.error ?? "Local Agent failed")
      return state.enabled === enabled && state.status === (enabled ? "running" : "stopped")
    }, enabled ? "Agent restart" : "Agent stop")
    await until(() => toggle()?.getAttribute("aria-checked") === String(enabled) && !toggle()!.disabled, "Saved Agent preference")
    require((await api.settings.getKeepAwake()).enabled === (context.phase === "start"), "Changing the local Agent must preserve Keep Awake")
    if (enabled) await verifyDeniedPermission()
    await leaveSettings()
    await until(() => enabled ? !!addWorkspace() && addWorkspace()!.getAttribute("aria-disabled") !== "true" : document.querySelector("aside")!.textContent!.includes("Offline"), "Catalog lifecycle refresh")
  }

  await until(() => !!document.querySelector("main h1") && !!settingsButton(), "Initial renderer route")
  const initial = await api.settings.get()
  if (context.phase === "disabled") {
    require(!initial.enabled && initial.status === "stopped", "Disabled startup must leave the Agent stopped")
    await openSettings()
    require(toggle()!.getAttribute("aria-checked") === "false", "Persisted disabled preference was not rendered")
    await leaveSettings()
    await until(() => document.querySelector("aside")!.textContent!.includes("Offline"), "Disabled machine status")
    require(!(await api.desktop.target()).online, "Disabled startup unexpectedly connected to a daemon")
    return {}
  }
  if (context.phase === "external") {
    require(!initial.enabled && initial.status === "running", "A separately running daemon must be reused even with hosting disabled")
    await until(sidebarWorkspace, "External daemon catalog")
    return {}
  }
  require(initial.enabled && initial.status === "running", "Default local Agent must be running")
  await until(() => !!addWorkspace() && addWorkspace()!.getAttribute("aria-disabled") !== "true", "Initial catalog connection")
  await openSettings()
  await verifyDeniedPermission()
  await verifyNotifications()
  const keepAwakeEnabled = context.phase === "start"
  require(keepAwakeToggle()!.getAttribute("aria-checked") === String(!keepAwakeEnabled), "Keep Awake must default off and restore the saved preference on restart")
  keepAwakeToggle()!.click()
  await until(() => keepAwakeToggle()?.getAttribute("aria-checked") === String(keepAwakeEnabled) && !keepAwakeToggle()!.disabled, "Saved Keep Awake preference")
  require((await api.settings.getKeepAwake()).enabled === keepAwakeEnabled, "Keep Awake did not update through Settings")
  let providerId: string | undefined
  if (context.phase === "start") providerId = await exerciseProviders()
  else {
    await openProviders()
    const provider = (await api.providers.list()).providers.find(provider => provider.id === context.providerId)
    require(provider?.name === "Work Codex updated" && provider.template === "codex" && provider.icon === "claude" && provider.binaryPath === `${context.checkoutPath}/custom-codex` && provider.env.DESKFLEET_SMOKE_PROFILE === "updated", "Provider configuration did not survive the app restart")
    require(document.querySelector(`[data-provider-id="${provider.id}"]`)?.textContent?.includes("Work Codex updated"), "Restored provider was not rendered")
    require(document.querySelector(`[data-provider-id="${provider.id}"] [data-provider-icon="claude"]`), "Restored provider icon was not rendered")
    await removeProvider(provider.id)
    providerId = provider.id
  }
  await leaveSettings()
  if (context.phase === "restart") {
    const workspace = (await api.catalog.list()).workspaces.find(value => value.id === context.workspaceId)
    require(workspace?.worktrees[0]?.directories[0]?.path === context.checkoutPath, "Workspace was not preserved after the app quit")
    const terminal = (await api.terminal.list()).find(value => value.id === context.terminalId)
    require(terminal?.status === "interrupted" && terminal.cwd === context.checkoutPath, "Quitting the app must stop its shells while preserving their history")
    await until(sidebarWorkspace, "Restored catalog sidebar")
    await change(false)
    return { workspaceId: workspace.id, terminalId: terminal.id, providerId }
  }

  require((await api.catalog.list()).workspaces.length === 0, "The isolated catalog must start empty")
  const workspace = await api.catalog.createWorkspace("Local Agent smoke", [{ path: context.checkoutPath }])
  await until(sidebarWorkspace, "Created catalog sidebar")
  const stoppedTerminal = await api.terminal.dial({ mode: "create", terminalId: crypto.randomUUID(), cwd: context.checkoutPath, cols: 80, rows: 24 })
  require(stoppedTerminal.status === "running", "Native terminal did not start")
  await change(false)
  await change(true)
  await until(sidebarWorkspace, "Catalog refresh after restart")
  const restored = (await api.catalog.list()).workspaces.find(value => value.id === workspace.id)
  require(restored?.worktrees[0]?.directories[0]?.path === context.checkoutPath, "Workspace did not survive daemon restart")
  const interrupted = (await api.terminal.list()).find(value => value.id === stoppedTerminal.id)
  require(interrupted?.status === "interrupted", "Turning the local Agent off must stop its terminal process while preserving history")
  const survivor = await api.terminal.dial({ mode: "create", terminalId: crypto.randomUUID(), cwd: context.checkoutPath, cols: 80, rows: 24 })
  require(survivor.status === "running", "Native terminal did not start after restart")
  return { workspaceId: workspace.id, terminalId: survivor.id, stoppedTerminalId: stoppedTerminal.id, providerId }
}

const argument = process.argv.find(value => value.startsWith("--local-agent-smoke-context="))
if (!argument) throw new Error("Missing local Agent smoke context")
const context = JSON.parse(argument.slice("--local-agent-smoke-context=".length)) as LocalAgentSmokeContext
// Start adapters as the packaged app does: this executable in Node mode, routed by the real entry.
configureAdapterHost({ command: process.execPath, args: [context.mainEntry], env: { ELECTRON_RUN_AS_NODE: "1" } })
app.setPath("userData", context.profileDirectory)
app.setPath("sessionData", context.profileDirectory)
registerRendererScheme()
keepRunningInBackground(app, () => {})

void app.whenReady().then(async () => {
  const controller = new LocalAgentController(
    join(app.getPath("userData"), "settings.json"),
    // Automated smoke runs must never display operating-system permission prompts.
    createLocalAgentRuntime({ directory: context.daemonDirectory, start: controlDirectory => startDaemon(0, { allowLocalControlForTests: true, controlDirectory, requestScreenCaptureAccess: async () => false, requestAccessibilityAccess: async () => false, requestFullDiskAccess: async () => null }) }),
    publishLocalAgentState,
  )
  let blockerId: number | undefined
  const keepAwake = new KeepAwakeController(join(app.getPath("userData"), "keep-awake.json"), {
    start(type) { blockerId = powerSaveBlocker.start(type); return blockerId },
    stop(id) { return powerSaveBlocker.stop(id) },
  })
  installDesktopMediaIpc()
  installSettings(controller, keepAwake, new NotificationSettingsController(join(app.getPath("userData"), "notifications.json")), new WorktreeRootSettingsController(context.daemonDirectory))
  // Quitting the app closes the daemon it hosts, as client.ts does on will-quit.
  const exit = () => { void controller.close().finally(() => { keepAwake.close(); app.exit(0) }) }
  process.on("message", exit)
  process.on("disconnect", exit)
  keepAwake.get()
  if (context.phase === "restart" && (blockerId === undefined || !powerSaveBlocker.isStarted(blockerId))) {
    throw new Error("The saved Keep Awake preference must start its sleep blocker before opening a window")
  }
  const initialized = await controller.initialize()
  if (initialized.status === "error") throw new Error(initialized.error)
  const identity = async () => createHash("sha256").update(JSON.stringify(await readDaemonDiscovery(context.daemonDirectory))).digest("hex")
  // These phases end with the hosted daemon switched off, so read its identity first.
  const reusedIdentity = context.phase === "restart" || context.phase === "external" ? await identity() : undefined
  denyChromiumPermissions()
  protocol.handle(RENDERER_SCHEME, async request => {
    if (request.method !== "GET") return new Response(null, { status: 405 })
    const path = resolveRendererResourcePath(request.url, context.rendererDirectory)
    return path ? net.fetch(pathToFileURL(path).toString()) : new Response(null, { status: 400 })
  })
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: {
      preload: context.preloadPath, sandbox: true, contextIsolation: true,
      nodeIntegration: false, backgroundThrottling: false,
      additionalArguments: ["--deskfleet-locale=en-US"],
    },
  })
  attachDesktopMedia(window)
  attachSettings(window)
  window.webContents.on("render-process-gone", (_event, details) => process.send?.({ error: `Renderer exited: ${details.reason}` }))
  await window.loadURL(BUNDLED_RENDERER_URL)
  const result = await window.webContents.executeJavaScript(`(${exerciseSettings.toString()})(${JSON.stringify(context)})`) as LocalAgentSmokeResult
  if (context.phase !== "disabled") result.daemonIdentity = reusedIdentity ?? await identity()
  if (context.phase === "start") {
    // Closing every window leaves the app, and the daemon it hosts, running.
    window.destroy()
    const observer = await DaemonClient.connect(() => {}, () => {}, context.daemonDirectory)
    try { result.survivedWindowClose = (await observer.call("catalogList", {})).workspaces.some(value => value.id === result.workspaceId) }
    finally { observer.close() }
  }
  if ((blockerId !== undefined && powerSaveBlocker.isStarted(blockerId)) !== (context.phase === "start")) {
    throw new Error("Keep Awake must preserve its blocker after window close and release it when disabled")
  }
  process.send?.({ result })
}).catch(error => {
  if (process.send) process.send({ error: String(error) }, () => app.exit(1))
  else app.exit(1)
})
