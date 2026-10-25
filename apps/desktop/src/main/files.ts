import { BrowserWindow, dialog, ipcMain, type WebContents } from "electron"
import type { CentralApi } from "@deskfleet/client/central"
import { FILES_CHANGED_EVENT, FILES_IPC_CHANNEL, type FileConflict, type FileLocation, type FileResourceRequest, type FilesApi, type FileTarget, type FileTransfer } from "@deskfleet/client/files"
import { DaemonClient } from "./daemon-client.ts"
import { isDesktopMediaSender } from "./desktop-media.ts"
import { createNativeFileEndpoint } from "./files-peer.ts"
import { WindowFiles } from "./files-controller.ts"

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid file operation")
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 32768 || value.includes("\0")) throw new Error("Invalid file path or identifier")
  return value
}
function target(value: unknown): FileTarget {
  const input = object(value)
  if (input.kind === "local") return { kind: "local", ...(input.grantId === undefined ? {} : { grantId: text(input.grantId) }) }
  if (input.kind === "machine") return { kind: "machine", machineId: text(input.machineId), teamId: text(input.teamId) }
  throw new Error("Invalid file target")
}
function location(value: unknown): FileLocation {
  const input = object(value)
  return { target: target(input.target), path: text(input.path) }
}
function conflict(value: unknown): FileConflict | undefined {
  if (value === undefined) return undefined
  if (["ask", "replace", "rename", "skip"].includes(String(value))) return value as FileConflict
  throw new Error("Invalid conflict action")
}
function resource(value: unknown): FileResourceRequest {
  const input = object(value)
  return { target: target(input.target), sessionId: text(input.sessionId), uri: text(input.uri) }
}

/** Validate the narrow main-process bridge; the renderer never receives a raw filesystem API. */
export async function invokeFiles(api: FilesApi, method: unknown, args: unknown): Promise<unknown> {
  if (typeof method !== "string" || !Array.isArray(args)) throw new Error("Invalid file operation")
  switch (method) {
    case "list": return api.list(target(args[0]), args[1] === undefined ? undefined : text(args[1]))
    case "chooseLocalDirectory": return api.chooseLocalDirectory()
    case "enqueue": {
      const request = object(args[0])
      if (request.kind !== undefined && request.kind !== "file" && request.kind !== "directory") throw new Error("Invalid file kind")
      return api.enqueue({ source: location(request.source), destination: location(request.destination), conflict: conflict(request.conflict), ...(request.kind ? { kind: request.kind } : {}) })
    }
    case "transfers": return api.transfers()
    case "cancel": return api.cancel(text(args[0]))
    case "retry": return api.retry(text(args[0]), conflict(args[1]))
    case "resolveResource": return api.resolveResource(resource(args[0]))
    case "readResource": return api.readResource(resource(args[0]))
    case "saveResource": return api.saveResource(resource(args[0]))
    default: throw new Error("Unknown file operation")
  }
}

/** Local development Sessions still resolve their captured context in the daemon. */
export async function localSessionDirectory(sessionId: string): Promise<string> {
  const client = await DaemonClient.connect(() => {}, () => {})
  try {
    const catalog = await client.call("catalogList", {})
    const worktree = catalog.workspaces.flatMap(workspace => workspace.worktrees).find(item => item.sessionId === sessionId)
    const path = worktree?.directories[0]?.path
    if (!path) throw new Error("Session worktree is unavailable")
    return path
  } finally { client.close() }
}

/** Main owns queues; each renderer document receives its own revocable authority. */
export function installFiles(central: CentralApi): { close(): Promise<void> } {
  const owners = new Map<WebContents, WindowFiles>()
  const watched = new Map<WebContents, () => void>()
  const closing = new Set<Promise<void>>()
  let closed = false
  const retire = (contents: WebContents) => {
    const previous = owners.get(contents)
    owners.delete(contents)
    if (!previous) return
    // close revokes synchronously, before dialogs and queued operations resume.
    const pending = previous.close().catch(error => console.error("File transfer cleanup failed", error)).finally(() => { closing.delete(pending) })
    closing.add(pending)
    if (!contents.isDestroyed()) contents.send(FILES_CHANGED_EVENT, [])
  }
  const owner = (contents: WebContents) => {
    if (closed || contents.isDestroyed()) throw new Error("File window has closed")
    let manager = owners.get(contents)
    if (manager) return manager
    const window = BrowserWindow.fromWebContents(contents)
    if (!window) throw new Error("File operation requires a window")
    manager = new WindowFiles({
      remoteEndpoint: async target => createNativeFileEndpoint(central, target),
      sessionDirectory: localSessionDirectory,
      chooseDirectory: async () => {
        const result = await dialog.showOpenDialog(window, {
          title: "Choose a local folder",
          properties: ["openDirectory", "createDirectory"],
        })
        return result.canceled ? null : result.filePaths[0] ?? null
      },
      confirmOverwrite: async path => (await dialog.showMessageBox(window, {
        type: "warning", title: "Replace local files", message: "Replace this item and all of its contents?",
        detail: path, buttons: ["Cancel", "Replace"], defaultId: 0, cancelId: 0, noLink: true,
      })).response === 1,
    })
    const current = manager
    manager.onChanged((transfers: FileTransfer[]) => {
      if (owners.get(contents) === current && !contents.isDestroyed()) contents.send(FILES_CHANGED_EVENT, transfers)
    })
    owners.set(contents, manager)
    if (!watched.has(contents)) {
      const navigate = (_event: unknown, _url: string, inPlace: boolean, isMainFrame: boolean) => {
        if (isMainFrame && !inPlace) retire(contents)
      }
      const gone = () => retire(contents)
      const destroyed = () => { retire(contents); watched.get(contents)?.(); watched.delete(contents) }
      contents.on("did-start-navigation", navigate)
      contents.on("render-process-gone", gone)
      contents.once("destroyed", destroyed)
      watched.set(contents, () => {
        contents.removeListener("did-start-navigation", navigate)
        contents.removeListener("render-process-gone", gone)
        contents.removeListener("destroyed", destroyed)
      })
    }
    return manager
  }
  const unsubscribe = central.onEvent(event => {
    if (event.type !== "accountChanged") return
    for (const contents of owners.keys()) retire(contents)
  })
  ipcMain.handle(FILES_IPC_CHANNEL, async (event, method: unknown, args: unknown) => {
    if (!isDesktopMediaSender(event)) throw new Error("File IPC is restricted to the main renderer")
    return invokeFiles(owner(event.sender), method, args)
  })
  return {
    async close() {
      closed = true
      unsubscribe(); ipcMain.removeHandler(FILES_IPC_CHANNEL)
      for (const contents of owners.keys()) retire(contents)
      for (const unwatch of watched.values()) unwatch()
      watched.clear()
      await Promise.all(closing)
    },
  }
}
