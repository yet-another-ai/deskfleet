import { app, BrowserWindow, net, protocol } from "electron"
import { pathToFileURL } from "node:url"
import { attachDesktopMedia, installDesktopMediaIpc } from "../../src/main/desktop-media.ts"
import { installRendererPermissions, registerRendererScheme, resolveRendererResourcePath } from "../../src/main/renderer-protocol.ts"
import { BUNDLED_RENDERER_URL, RENDERER_SCHEME } from "../../src/shared/renderer-security.ts"
import type { DeskfleetDesktopApi } from "../../../../packages/client/src/desktop-api.ts"

export interface CatalogSmokeContext {
  phase: "create" | "restore"
  rendererDirectory: string
  preloadPath: string
  checkoutPath: string
  initialPath: string
  updatedPath: string
  checkoutAncestors: string[]
  initialAncestors: string[]
  updatedAncestors: string[]
  workspaceId?: string
  worktreeId?: string
}

export interface CatalogSmokeResult {
  workspaceId: string
  worktreeId: string
  terminalId?: string
  restored?: boolean
}

// This function is evaluated in the actual built renderer, after its preload.
// Keep every runtime dependency inside the function for executeJavaScript.
async function exerciseCatalog(context: CatalogSmokeContext): Promise<CatalogSmokeResult> {
  const api = (window as unknown as { deskfleet: DeskfleetDesktopApi }).deskfleet
  function require(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
  }
  async function until(predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
    const deadline = Date.now() + 12_000
    while (!await predicate()) {
      if (Date.now() > deadline) {
        throw new Error(`${description} timed out; renderer: ${document.body.innerText.slice(-3_000)}`)
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  function button(label: string): HTMLButtonElement | undefined {
    return [...document.querySelectorAll("button")].find(element =>
      element.getAttribute("aria-label") === label || element.textContent?.trim() === label)
  }
  async function click(label: string): Promise<void> {
    await until(() => {
      const element = button(label)
      return !!element && !element.disabled && element.getAttribute("aria-disabled") !== "true"
    }, `Button ${label}`)
    button(label)!.click()
  }
  async function fill(name: string, value: string): Promise<HTMLInputElement> {
    await until(() => !!document.querySelector(`input[name="${name}"]`), `Input ${name}`)
    const input = document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!
    input.value = value
    input.dispatchEvent(new Event("input", { bubbles: true }))
    return input
  }
  function picker(): HTMLElement | null {
    return document.querySelector("[data-current-path]")?.closest("[role=dialog]") ?? null
  }
  async function chooseFolder(paths: string[]): Promise<void> {
    await until(() => picker()?.getAttribute("data-state") === "open", "Folder picker")
    require(picker()!.textContent?.includes("Choose a folder"), "Directory selection must use the custom folder dialog")
    for (const path of paths) {
      const currentPath = () => picker()?.querySelector("[data-current-path]")?.getAttribute("data-current-path")
      if (currentPath() === path) continue
      const destination = () => [...picker()!.querySelectorAll<HTMLButtonElement>("button[data-path]")]
        .find(element => element.getAttribute("data-path") === path)
      await until(() => !!destination() && !destination()!.disabled, `Folder ${path}`)
      destination()!.click()
      await until(() => currentPath() === path, `Browsing ${path}`)
    }
    await click("Select folder")
    await until(() => !picker(), "Folder selection")
  }
  async function cancelFolder(): Promise<void> {
    await until(() => picker()?.getAttribute("data-state") === "open", "Folder picker")
    const cancel = [...picker()!.querySelectorAll("button")].find(element => element.textContent?.trim() === "Cancel")
    require(cancel, "Folder picker must support cancellation")
    cancel.click()
    await until(() => !picker(), "Folder cancellation")
  }
  async function snapshotWorkspace() {
    return (await api.catalog.list()).workspaces.find(workspace => workspace.name === "Catalog smoke renamed")
  }

  await until(() => !!button("Add workspace") && button("Add workspace")!.getAttribute("aria-disabled") !== "true", "Local catalog")

  if (context.phase === "restore") {
    const workspace = await snapshotWorkspace()
    require(workspace && workspace.id === context.workspaceId, "Workspace identity did not survive a fresh client")
    const main = workspace.worktrees.find(value => value.id === context.worktreeId)
    require(main && !main.sessionId, "Main worktree did not persist")
    require(main.directories[0]?.path === context.updatedPath && main.directories[1]?.path === context.checkoutPath, "Directory order/default did not persist")
    await until(() => [...document.querySelectorAll("a")].some(link => link.textContent?.trim() === workspace.name), "Restored sidebar workspace")
    const link = [...document.querySelectorAll("a")].find(element => element.textContent?.trim() === workspace.name)!
    link.click()
    await until(() => location.hash.includes("/workspaces/") && !!document.querySelector("main")?.innerText.includes(context.updatedPath), "Restored workspace directory")
    require(!button("Add worktree") && !button("Delete worktree"), "Worktrees must not have manual maintenance controls")
    require(!document.querySelector('a[href*="/worktrees/"]'), "The internal main worktree must not appear in workspace navigation")
    require(document.querySelector("main")!.innerText.includes("No sessions yet."), "A restored workspace without sessions must show its empty session list")
    await click("Delete workspace")
    await click("Confirm deletion")
    await until(async () => (await api.catalog.list()).workspaces.length === 0, "Workspace deletion")
    return { workspaceId: workspace.id, worktreeId: main.id, restored: true }
  }

  require((await api.catalog.list()).workspaces.length === 0, "Smoke daemon catalog was not empty")
  await click("Add workspace")
  const workspaceInput = await fill("workspace-name", "Catalog smoke workspace")
  workspaceInput.form!.requestSubmit()
  await until(() => !!workspaceInput.form!.querySelector('[role="alert"]'), "Missing directory validation")
  require(!document.querySelector('input[name^="directory-name"]'), "Directories must have no name input")
  require(!document.querySelector('input[name^="directory-path"]'), "Workspace paths must be chosen through the folder picker")
  await click("Directory 1")
  await chooseFolder(context.checkoutAncestors)
  await click("Add directory")
  await cancelFolder()
  require(!button("Directory 2"), "Cancelling folder selection must not add a binding")
  await click("Add directory")
  await chooseFolder(context.initialAncestors)
  workspaceInput.form!.requestSubmit()
  await until(() => location.hash.includes("/workspaces/") && !!document.querySelector("main")?.innerText.includes("No sessions yet."), "Workspace creation navigation")
  const created = (await api.catalog.list()).workspaces[0]!
  require(created.worktrees.length === 1 && !created.worktrees[0]!.sessionId, "Creation must automatically create exactly one main Worktree")
  require(created.worktrees[0]!.directories[0]?.path === context.checkoutPath, "Initial default must be the first configured path")
  require(created.worktrees[0]!.directories[1]?.path === context.initialPath, "Folder selection must add the selected directory")
  require(!button("Add worktree"), "Workspace must not expose independent Worktree creation")
  require(!document.querySelector('a[href*="/worktrees/"]'), "Creating a workspace must not expose its internal main worktree")
  require(!document.body.innerText.includes("Main worktree"), "Workspace UI must not label a main worktree")
  require(document.querySelector("main")!.innerText.includes("No sessions yet."), "New workspaces must show an empty session list")
  await click("New session")
  await until(() => location.hash === "#/", "Workspace new session navigation")
  const targets = [...document.querySelectorAll("[data-composer-context]")].map(chip => chip.textContent?.trim())
  // Machine, Workspace, the choice of a new Session context, and the provider.
  require(targets.length === 4 && targets.includes(created.name) && targets.includes("New worktree") && targets.includes("Codex"), "The composer must target the selected workspace and provider without an existing worktree")
  require(document.querySelector('aside[aria-label="Changes"]')!.textContent?.includes("Git changes are available within a session."), "Composer must not inspect a workspace as a Session Worktree")
  const workspaceLink = [...document.querySelectorAll("a")].find(element => element.textContent?.trim() === created.name)
  require(workspaceLink, "Created workspace must remain available in the sidebar")
  workspaceLink.click()
  await until(() => location.hash.includes("/workspaces/"), "Returning to workspace")

  await click("Edit workspace")
  const renameInput = await fill("workspace-name", "Catalog smoke renamed")
  await click("Directory 2")
  await chooseFolder(context.updatedAncestors)
  await click("Move directory 2 up")
  renameInput.form!.requestSubmit()
  await until(async () => !!await snapshotWorkspace() && !document.querySelector('input[name="workspace-name"]'), "Workspace update")
  const workspace = (await snapshotWorkspace())!
  const main = workspace.worktrees[0]!
  require(main.id === created.worktrees[0]!.id, "Editing Workspace must preserve the main Worktree identity")
  require(main.directories[0]?.path === context.updatedPath, "Moving a path to first must change the default")

  await click("Open terminal in default directory")
  await until(() => /^#\/machines\/[^/]+\/control\?/u.test(location.hash), "Default terminal control navigation")
  const terminals = await api.terminal.list()
  require(terminals.length === 1 && terminals[0]?.cwd === context.updatedPath, "Default terminal did not use the first path")
  const terminalId = terminals[0].id
  const query = new URLSearchParams(location.hash.split("?", 2)[1])
  require(query.get("tab") === "terminal" && query.get("terminal") === terminalId, "Default terminal route must select its control tab and terminal ID")
  await until(() => document.querySelector('[role="tablist"][aria-label="Remote control"] [aria-selected="true"]')?.textContent?.trim() === "Terminal", "Selected Terminal control tab")
  await until(() => document.querySelector(`[role="tab"][data-terminal-id="${terminalId}"]`)?.getAttribute("aria-selected") === "true", "Selected default shell")
  return { workspaceId: workspace.id, worktreeId: main.id, terminalId }

}

registerRendererScheme()

void app.whenReady().then(async () => {
  const argument = process.argv.find(value => value.startsWith("--catalog-smoke-context="))
  if (!argument) throw new Error("Missing catalog smoke context")
  const context = JSON.parse(argument.slice("--catalog-smoke-context=".length)) as CatalogSmokeContext
  installRendererPermissions()
  protocol.handle(RENDERER_SCHEME, async request => {
    if (request.method !== "GET") return new Response(null, { status: 405 })
    const path = resolveRendererResourcePath(request.url, context.rendererDirectory)
    if (!path) return new Response(null, { status: 400 })
    return net.fetch(pathToFileURL(path).toString())
  })
  installDesktopMediaIpc()
  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      preload: context.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      additionalArguments: ["--deskfleet-locale=en-US"],
    },
  })
  attachDesktopMedia(window)
  window.webContents.on("render-process-gone", (_event, details) => process.send?.({ error: `Renderer exited: ${details.reason}` }))
  process.on("message", () => app.quit())
  process.on("disconnect", () => app.quit())
  await window.loadURL(BUNDLED_RENDERER_URL)
  const result = await window.webContents.executeJavaScript(`(${exerciseCatalog.toString()})(${JSON.stringify(context)})`) as CatalogSmokeResult
  process.send?.({ result })
}).catch(error => { process.send?.({ error: String(error) }); app.quit() })
