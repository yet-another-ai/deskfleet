import { BrowserWindow, dialog, ipcMain } from "electron"
import type { CentralApi } from "@deskfleet/client/central"
import { FileTransferManager } from "@deskfleet/client/file-transfers"
import { FILES_CHANGED_EVENT, FILES_IPC_CHANNEL, type FileConflict, type FileLocation, type FileResourceRequest, type FilesApi, type FileTarget, type FileTransfer } from "@deskfleet/client/files"
import { FilesService } from "../../../daemon/src/files-service.ts"
import { DaemonClient } from "./daemon-client.ts"
import { isDesktopMediaSender } from "./desktop-media.ts"
import { createNativeFileEndpoint } from "./files-peer.ts"

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
  if (input.kind === "local") return { kind: "local" }
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

/** Hosted outside every BrowserWindow so transfers continue while the app is in the tray. */
export function installFiles(central: CentralApi): { close(): Promise<void> } {
  const publish = (transfers: FileTransfer[]) => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(FILES_CHANGED_EVENT, transfers)
  }
  const create = () => {
    const local = new FilesService(localSessionDirectory)
    const manager = new FileTransferManager({
      endpoint: async fileTarget => fileTarget.kind === "local" ? local : createNativeFileEndpoint(central, fileTarget),
      chooseLocalDirectory: async () => {
        const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] })
        const path = result.filePaths[0]
        return result.canceled || !path ? null : (await local.call("list", { path })).value
      },
    })
    return manager
  }
  let manager = create()
  let unpublish = manager.onChanged(publish)
  const closing = new Set<Promise<void>>()
  const unsubscribe = central.onEvent(event => {
    if (event.type !== "accountChanged") return
    const previous = manager
    unpublish()
    manager = create()
    unpublish = manager.onChanged(publish)
    const pending = previous.close().catch(error => console.error("File transfer cleanup failed", error)).finally(() => { closing.delete(pending) })
    closing.add(pending)
    publish([])
  })
  ipcMain.handle(FILES_IPC_CHANNEL, async (event, method: unknown, args: unknown) => {
    if (!isDesktopMediaSender(event)) throw new Error("File IPC is restricted to the main renderer")
    return invokeFiles(manager, method, args)
  })
  return {
    async close() {
      unsubscribe(); unpublish(); ipcMain.removeHandler(FILES_IPC_CHANNEL)
      await Promise.all([manager.close(), ...closing])
    },
  }
}
