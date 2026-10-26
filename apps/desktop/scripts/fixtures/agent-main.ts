import { app, BrowserWindow, net, protocol } from "electron"
import { execFile } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { attachDesktopMedia, installDesktopMediaIpc } from "../../src/main/desktop-media.ts"
import { installRendererPermissions, registerRendererScheme, resolveRendererResourcePath } from "../../src/main/renderer-protocol.ts"
import { BUNDLED_RENDERER_URL, RENDERER_SCHEME } from "../../src/shared/renderer-security.ts"
import type { DeskfleetDesktopApi } from "../../../../packages/client/src/desktop-api.ts"

export interface AgentSmokeContext {
  phase: "create" | "restore"
  rendererDirectory: string
  preloadPath: string
  repository: string
  screenshotPath: string
  questionScreenshotPath: string
  sessionId?: string
  workspaceId?: string
  worktreeId?: string
  providerId?: string
}
export interface AgentSmokeResult {
  sessionId: string
  workspaceId: string
  worktreeId: string
  providerId: string
  conversationEntries: number
  permissionId: string
}

const execute = promisify(execFile)

/** Exercise production Git reads and rendering independently of provider events. */
async function exerciseGitChanges(phase: "initial" | "live" | "restore"): Promise<void> {
  async function until(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 20_000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`${label} timed out; renderer: ${document.body.innerText.slice(-5_000)}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  const diff = () => document.querySelector<HTMLElement>("[data-git-diff]")
  async function open(path: string, kind: string, expected: string): Promise<void> {
    const row = () => [...document.querySelectorAll<HTMLButtonElement>("button[data-git-path][data-git-kind]")]
      .find(element => element.dataset.gitPath === path && element.dataset.gitKind === kind)
    await until(() => !!row() && !row()!.disabled, `Git ${kind} ${path}`)
    row()!.click()
    await until(() => !!diff()?.innerText.includes(expected), `Git ${kind} preview`)
  }
  async function close(): Promise<void> {
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")
    if (!dialog) throw new Error("Git diff dialog was missing")
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }))
    await until(() => !diff(), "Git diff dialog close")
  }

  if (phase !== "live") {
    if (!document.querySelector('aside[aria-label="Changes"]')) throw new Error("Changes panel was missing")
    if (phase === "initial") {
      await open("README.md", "staged", "+Smoke staged baseline")
      await close()
      await open("new-file.txt", "untracked", "+Smoke untracked file")
      await close()
    }
    await open("README.md", "unstaged", phase === "initial" ? "+Smoke diff first version" : "+Smoke diff live version")
  } else {
    await until(() => !!diff()?.innerText.includes("+Smoke diff live version") && !diff()!.innerText.includes("+Smoke diff first version"), "Live Git diff refresh without agent events")
  }
}

// Evaluate in the production renderer with its production sandboxed preload.
async function exerciseAgent(context: AgentSmokeContext): Promise<AgentSmokeResult> {
  const api = (window as unknown as { deskfleet: DeskfleetDesktopApi }).deskfleet
  function require(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
  }
  async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
    const deadline = Date.now() + 20_000
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error(`${label} timed out; route ${location.hash}; renderer: ${document.body.innerText.slice(-5_000)}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  function button(label: string, scope: ParentNode = document): HTMLButtonElement | undefined {
    return [...scope.querySelectorAll("button")].find(element => element.getAttribute("aria-label") === label || element.textContent?.trim() === label)
  }
  async function click(label: string, scope: () => ParentNode = () => document): Promise<void> {
    await until(() => { const value = button(label, scope()); return !!value && !value.disabled && value.getAttribute("aria-disabled") !== "true" }, `Button ${label}`)
    button(label, scope())!.click()
  }
  const conversation = () => document.querySelector<HTMLOListElement>('[aria-label="Conversation"]')
  const backlog = () => document.querySelector<HTMLElement>('[aria-label="Queued"]')
  const permissions = () => document.querySelector<HTMLElement>('[aria-label="Permissions"]')
  const question = () => conversation()?.querySelector<HTMLElement>('[data-testid="agent-elicitation"]')
  const prompt = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')
  const configuration = () => document.querySelector<HTMLElement>("[data-agent-configuration-menu]")
  const configurationTrigger = () => document.querySelector<HTMLButtonElement>("[data-agent-configuration-trigger]")
  const configurationControl = (kind: "agent" | "model" | "reasoning") => configuration()?.querySelector<HTMLButtonElement>(`[data-agent-control="${kind}"]`)
  const configurationChoice = (value: string) => document.querySelector<HTMLButtonElement>(`[data-agent-configuration-options] [role="menuitemradio"][data-value="${value}"]`)
  async function expandConfiguration(): Promise<void> {
    await until(() => !!configurationTrigger() && !configurationTrigger()!.disabled, "Agent configuration trigger")
    if (!configuration()) configurationTrigger()!.click()
    await until(() => {
      const controls = configuration()?.querySelectorAll<HTMLButtonElement>("[data-agent-control]")
      return controls?.length === 4 && !configurationControl("model")?.disabled && !configurationControl("reasoning")?.disabled
    }, "Dynamic Agent, model, and reasoning menu")
    require(configuration()!.querySelector('[data-agent-control="agent"]')?.textContent?.includes("Codex"), "Agent menu must display Codex")
  }
  async function openConfigurationOptions(kind: "agent" | "model" | "reasoning"): Promise<void> {
    await expandConfiguration()
    configurationControl(kind)!.click()
    await until(() => !!document.querySelector('[data-agent-configuration-options] [role="menuitemradio"]'), `${kind} choices`)
    if (kind === "model") require(configurationChoice("fast")?.textContent?.trim() === "Smoke Fast", "Model options must come from the provider")
  }
  async function selectedConfiguration(kind: "agent" | "model" | "reasoning"): Promise<string | null> {
    await openConfigurationOptions(kind)
    return document.querySelector('[data-agent-configuration-options] [role="menuitemradio"][aria-checked="true"]')?.getAttribute("data-value") ?? null
  }
  async function selectConfiguration(kind: "agent" | "model" | "reasoning", value: string): Promise<void> {
    await openConfigurationOptions(kind)
    await until(() => !!configurationChoice(value) && !configurationChoice(value)!.disabled, `${value} choice`)
    configurationChoice(value)!.click()
    await until(async () => await selectedConfiguration(kind) === value, `Confirmed agent configuration ${value}`)
  }
  async function collapseConfiguration(): Promise<void> {
    if (configuration()) configurationTrigger()!.click()
    await until(() => !configuration(), "Collapsed Agent configuration")
  }
  async function send(text: string, label: string): Promise<void> {
    await until(() => !!prompt(), "Prompt composer")
    prompt()!.value = text
    prompt()!.dispatchEvent(new Event("input", { bubbles: true }))
    await click(label)
    await until(() => prompt()?.value === "", `Submission ${text}`)
  }
  async function openSession(id: string): Promise<void> {
    const link = () => document.querySelector<HTMLAnchorElement>(`a[href="#/sessions/${id}"]`)
    await until(() => !!link(), "Session sidebar link")
    link()!.click()
    await until(() => location.hash === `#/sessions/${id}` && !!conversation(), "Session navigation")
  }
  async function verifyConversation(): Promise<void> {
    // Finished turns fold their work; expand every turn to inspect the full persisted journal.
    const folded = () => conversation()?.querySelectorAll<HTMLButtonElement>('[data-turn-work][aria-expanded="false"]') ?? []
    for (const toggle of folded()) toggle.click()
    await until(() => !folded().length, "Expanded turn work")
    const text = conversation()?.innerText ?? ""
    for (const marker of ["Smoke first prompt", "stream one 中文", "stream two", "Smoke selected steer", "steer received", "permission accepted", "question answered", "Smoke queued candidate", "queued reply", "Smoke changed model prompt", "changed model reply"]) {
      require(text.split(marker).length === 2, `Expected exactly one ${marker} in persisted conversation: ${text}`)
    }
    require(!backlog(), "All submitted inputs should have left the backlog")
    require(!!conversation()?.querySelector("[data-permission-id]")?.textContent?.includes("Allow smoke edit"), "Resolved permission choice was not retained")
    require(!permissions(), "Resolved permission must not be actionable")
    require(question()?.textContent?.includes("Inline form") && question()?.textContent?.includes("Support keyboard navigation."), "User answers were not retained in conversation history")
    require(!question()?.querySelector('[data-testid="elicitation-submit"]'), "Answered question must not remain actionable")
  }

  await until(() => !!button("Add workspace") && button("Add workspace")!.getAttribute("aria-disabled") !== "true", "Daemon catalog connection")
  let sessionId = context.sessionId
  let workspaceId = context.workspaceId
  let worktreeId = context.worktreeId
  let providerId = context.providerId
  if (context.phase === "create") {
    require((await api.catalog.list()).workspaces.length === 0, "Smoke catalog must start empty")
    const workspace = await api.catalog.createWorkspace("Agent smoke workspace", [{ path: context.repository }])
    workspaceId = workspace.id
    const configuredProvider = await api.providers.create({ template: "codex", name: "Smoke Codex", binaryPath: `${context.repository}/smoke-codex`, env: { DESKFLEET_SMOKE_PROFILE: "configured" } })
    providerId = configuredProvider.id
    await until(() => [...document.querySelectorAll("[data-composer-context]")].some(element => element.textContent?.includes(workspace.name)), "New Session workspace target")
    require(location.hash === "#/", "Initial route must be New Session")
    await expandConfiguration()
    await selectConfiguration("agent", providerId)
    require(configurationControl("agent")?.textContent?.includes("Smoke Codex"), "Agent submenu must select the configured provider")
    await selectConfiguration("model", "fast")
    await selectConfiguration("reasoning", "high")
    require((await api.catalog.list()).workspaces[0]!.worktrees.length === 1, "Draft model discovery must not create a managed Session Worktree")
    await collapseConfiguration()
    await send("Smoke first prompt", "Send")
    await until(() => /^#\/sessions\/[0-9]+$/u.test(location.hash), "Created Session route")
    sessionId = location.hash.split("/").at(-1)!
    await until(() => !!conversation()?.innerText.includes("stream two") && !!button("Cancel turn"), "Live streamed response before turn completion")
    await send("Smoke queued candidate", "Add to backlog")
    await send("Smoke selected steer", "Add to backlog")
    await until(() => backlog()?.querySelectorAll("li[data-input-id]").length === 2, "Two visible backlog candidates")
    const selected = () => [...backlog()!.querySelectorAll<HTMLElement>("li[data-input-id]")].find(element => element.innerText.includes("Smoke selected steer"))!
    await click("Steer now", selected)
    await until(() => !!button("Allow smoke edit", permissions() ?? document), "Live permission request")
    require(backlog()?.innerText.includes("Smoke queued candidate"), "Steering a selected candidate must retain the older candidate")
    require(!backlog()?.innerText.includes("Smoke selected steer"), "Steered input remained in the candidate list")
    const permissionId = permissions()!.querySelector("[data-permission-id]")!.getAttribute("data-permission-id")
    const newSession = document.querySelector<HTMLAnchorElement>('a[href="#/"]')
    require(newSession, "New Session navigation link was missing")
    newSession.click()
    await until(() => location.hash === "#/" && !conversation(), "Leaving the running Session")
    await openSession(sessionId)
    await until(() => !!button("Allow smoke edit", permissions() ?? document), "Pending permission after returning")
    require(permissions()!.querySelector("[data-permission-id]")!.getAttribute("data-permission-id") === permissionId, "Returning created a second permission request")
    await click("Allow smoke edit", () => permissions()!)
    await until(() => !!question()?.querySelector('[data-testid="elicitation-submit"]'), "Inline user question")
    const choice = question()!.querySelector<HTMLInputElement>('input[name="approach"][value="Inline form"]')
    const detail = question()!.querySelector<HTMLInputElement>('input[name="details"]')
    require(choice && detail, "Question must render choice and free-text fields")
    choice.click()
    detail.value = "Support keyboard navigation."
    detail.dispatchEvent(new Event("input", { bubbles: true }))
    const questionId = question()!.dataset.elicitationId
    newSession.click()
    await until(() => location.hash === "#/" && !conversation(), "Leaving the question pending")
    await openSession(sessionId)
    await until(() => question()?.dataset.elicitationId === questionId, "Same question after returning")
    require(question()!.querySelector<HTMLInputElement>('input[name="approach"][value="Inline form"]')?.checked, "Question choice draft was lost during navigation")
    require(question()!.querySelector<HTMLInputElement>('input[name="details"]')?.value === "Support keyboard navigation.", "Question text draft was lost during navigation")
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    console.info("deskfleet-elicitation-preview")
    await until(() => (window as unknown as { elicitationPreviewCaptured?: boolean }).elicitationPreviewCaptured === true, "Question screenshot captured")
    const submit = question()!.querySelector<HTMLButtonElement>('[data-testid="elicitation-submit"]')
    require(submit && !submit.disabled, "Valid question answers must be submittable")
    submit.click()
    await until(() => !!conversation()?.innerText.includes("queued reply") && !button("Cancel turn") && !backlog(), "Backlog execution after permission and first turn completion")
    await expandConfiguration()
    require(configurationControl("agent")?.disabled && configurationControl("agent")?.dataset.value === providerId, "A running Session must retain its selected provider")
    require(await selectedConfiguration("model") === "fast" && await selectedConfiguration("reasoning") === "high", "A running Session must retain its draft model and reasoning selections")
    await selectConfiguration("model", "balanced")
    require(await selectedConfiguration("reasoning") === "medium", "Changing the Session model must refresh its provider-supplied reasoning configuration")
    await collapseConfiguration()
    await send("Smoke changed model prompt", "Send")
    await until(() => !!conversation()?.innerText.includes("changed model reply") && !button("Cancel turn"), "Prompt with updated Session model")
    const catalog = await api.catalog.list()
    const worktrees = catalog.workspaces.find(value => value.id === workspaceId)!.worktrees.filter(value => value.sessionId === sessionId)
    require(worktrees.length === 1 && worktrees[0]!.directories[0]?.path !== context.repository, "Session must own exactly one derived Git Worktree")
    worktreeId = worktrees[0]!.id
  } else {
    require(sessionId && workspaceId && worktreeId && providerId, "Restore identities are required")
    await openSession(sessionId)
    await until(() => !!conversation()?.innerText.includes("changed model reply"), "Conversation replay after daemon restart")
    require(![...document.querySelectorAll('[role="status"]')].some(element => /stopped|interrupted|Resume/u.test(element.textContent ?? "")), "An interrupted agent must not ask to be resumed")
    const workspace = (await api.catalog.list()).workspaces.find(value => value.id === workspaceId)
    require(workspace?.worktrees.some(value => value.id === worktreeId && value.sessionId === sessionId), "Restart replaced the Session's Worktree")
    require(!button("Cancel turn"), "Restart must not silently re-run a completed prompt")
  }
  await until(() => ![...document.querySelectorAll('[role="status"]')].some(element => element.textContent?.includes("Restoring conversation")), "History replay completed")
  await verifyConversation()
  if (context.phase === "restore") {
    // A Session shell opens in the bottom panel, in the Session's own Worktree.
    await click("Show terminal")
    const panel = () => document.querySelector<HTMLElement>('[aria-label="Session terminals"]')
    await until(() => !!panel(), "Session terminal panel")
    await until(() => !!panel()?.querySelector('[data-connection="connected"]'), "Automatically created Session shell connection")
    const screen = () => panel()?.querySelector(".xterm-rows")?.textContent ?? ""
    await until(() => screen().trim().length > 0, "Session shell prompt")
    // Type through xterm's own input element, as a user would.
    const input = panel()!.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!
    for (const key of "pwd\r") input.dispatchEvent(new KeyboardEvent("keypress", { key, charCode: key.charCodeAt(0), bubbles: true }))
    await until(() => screen().includes("session-worktrees"), "Session shell runs in the Session's Worktree")
    const shells = await api.terminal.list()
    require(shells.length === 1 && shells[0]!.worktreeId === worktreeId, "The Session shell must belong to the Session's Worktree")
    require(!document.querySelector('aside a[href^="#/terminals/"]'), "Session shells must stay out of the sidebar")
    await click("Hide terminal", () => panel()!)
    await until(() => !panel(), "Hidden Session terminal panel")
    await click("Show terminal")
    await until(() => !!panel()?.querySelector('[data-connection="connected"]'), "Reattached Session shell")
    const reattached = await api.terminal.list()
    require(reattached.length === 1 && reattached[0]!.id === shells[0]!.id, "Reopening the panel must reuse its existing shell")
    const hangup = panel()!.querySelector<HTMLButtonElement>('button[aria-label^="Hang up "]')
    require(hangup, "Session shell close button was missing")
    hangup.click()
    await until(() => !panel() && !!button("Show terminal"), "Closing the last shell hides the panel")
    require((await api.terminal.list()).length === 0, "Closing the last tab must hang up the shell")
    await click("Show terminal")
    await until(() => !!panel()?.querySelector('[data-connection="connected"]'), "Reopening the empty panel creates a shell")
    const recreated = await api.terminal.list()
    require(recreated.length === 1 && recreated[0]!.id !== shells[0]!.id && recreated[0]!.worktreeId === worktreeId, "The reopened panel must create exactly one new shell in the same Session Worktree")
  }
  require(sessionId && workspaceId && worktreeId && providerId, "Session resource identities were missing")
  require(await selectedConfiguration("model") === "balanced", "The Session's selected model must survive history replay")
  require(configurationControl("agent")?.dataset.value === providerId && configurationControl("agent")?.textContent?.includes("Smoke Codex"), "The Session's configured provider must survive history replay")
  const permissionId = conversation()!.querySelector("[data-permission-id]")!.getAttribute("data-permission-id")!
  return { sessionId, workspaceId, worktreeId, providerId, permissionId, conversationEntries: conversation()!.querySelectorAll("[data-conversation-entry]").length }
}

registerRendererScheme()
void app.whenReady().then(async () => {
  const argument = process.argv.find(value => value.startsWith("--agent-smoke-context="))
  if (!argument) throw new Error("Missing Agent smoke context")
  const context = JSON.parse(argument.slice("--agent-smoke-context=".length)) as AgentSmokeContext
  installRendererPermissions()
  protocol.handle(RENDERER_SCHEME, async request => {
    if (request.method !== "GET") return new Response(null, { status: 405 })
    const path = resolveRendererResourcePath(request.url, context.rendererDirectory)
    return path ? net.fetch(pathToFileURL(path).toString()) : new Response(null, { status: 400 })
  })
  installDesktopMediaIpc()
  const window = new BrowserWindow({
    show: false, width: 1280, height: 960,
    webPreferences: { preload: context.preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, additionalArguments: ["--deskfleet-locale=en-US"] },
  })
  attachDesktopMedia(window)
  let questionCaptured = false
  window.webContents.on("console-message", event => {
    if (event.message !== "deskfleet-elicitation-preview") return
    void (async () => {
      await writeFile(context.questionScreenshotPath, (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG())
      questionCaptured = true
      await window.webContents.executeJavaScript("window.elicitationPreviewCaptured = true")
    })().catch(error => process.send?.({ error: String(error) }))
  })
  window.webContents.on("render-process-gone", (_event, details) => process.send?.({ error: `Renderer exited: ${details.reason}` }))
  process.on("message", () => app.quit())
  process.on("disconnect", () => app.quit())
  await window.loadURL(BUNDLED_RENDERER_URL)
  let result: AgentSmokeResult
  try {
    result = await window.webContents.executeJavaScript(`(${exerciseAgent.toString()})(${JSON.stringify(context)})`) as AgentSmokeResult
    const worktreeDirectory = await window.webContents.executeJavaScript(`window.deskfleet.catalog.list().then(snapshot => snapshot.workspaces.flatMap(workspace => workspace.worktrees).find(worktree => worktree.id === ${JSON.stringify(result.worktreeId)})?.directories[0]?.path)`) as string | undefined
    if (!worktreeDirectory) throw new Error("Session checkout directory was missing")
    if (context.phase === "create") {
      await writeFile(join(worktreeDirectory, "README.md"), "Smoke staged baseline\n")
      await execute("git", ["-C", worktreeDirectory, "add", "--", "README.md"])
      await writeFile(join(worktreeDirectory, "README.md"), "Smoke diff first version\n")
      await writeFile(join(worktreeDirectory, "new-file.txt"), "Smoke untracked file\n")
      await window.webContents.executeJavaScript(`(${exerciseGitChanges.toString()})("initial")`)
      // Preserve both the status letter and line counts: polling must fetch content, too.
      await writeFile(join(worktreeDirectory, "README.md"), "Smoke diff live version\n")
      await window.webContents.executeJavaScript(`(${exerciseGitChanges.toString()})("live")`)
    } else {
      await window.webContents.executeJavaScript(`(${exerciseGitChanges.toString()})("restore")`)
    }
  } finally {
    // Keep one capture per hidden window: the first phase previews the question;
    // the restore phase captures the final Git view. Repeated hidden-window
    // captures can stall the compositor on Wayland.
    if (!questionCaptured) await writeFile(context.screenshotPath, (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG())
  }
  process.send?.({ result })
}).catch(error => { process.send?.({ error: String(error) }); app.quit() })
