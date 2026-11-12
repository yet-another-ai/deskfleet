import { BrowserWindow, dialog, ipcMain, shell, type WebContents } from "electron"
import type { CentralApi } from "@deskfleet/client/central"
import { FILES_CHANGED_EVENT, FILES_IPC_CHANNEL, FILES_RESOURCE_PROGRESS_EVENT, type FileAttachmentUploadRequest, type FileConflict, type FileLocation, type FileReadResourceProgress, type FileResourceRequest, type FilesApi, type FileTarget, type FileTransfer } from "@deskfleet/client/files"
import { isDesktopMediaSender } from "./desktop-media.ts"
import { createNativeFileEndpoint } from "./files-peer.ts"
import { WindowFiles } from "./files-controller.ts"
import { isLocalFileTarget } from "./files-local.ts"
import { DaemonClient } from "./daemon-client.ts"

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
function attachmentUpload(value: unknown): FileAttachmentUploadRequest {
  const input = object(value)
  if (!(input.data instanceof Uint8Array)) throw new Error("Invalid attachment data")
  const sessionId = input.sessionId === undefined ? undefined : text(input.sessionId)
  const draftId = input.draftId === undefined ? undefined : text(input.draftId)
  if (Boolean(sessionId) === Boolean(draftId)) throw new Error("Choose either a Session or draft attachment target")
  return {
    target: target(input.target),
    ...(sessionId ? { sessionId } : { draftId }),
    name: text(input.name),
    data: input.data,
  }
}

/** Validate the narrow main-process bridge; the renderer never receives a raw filesystem API. */
export async function invokeFiles(
  api: FilesApi,
  method: unknown,
  args: unknown,
  onResourceProgress?: (requestId: string, progress: FileReadResourceProgress) => void,
  uploads?: Map<string, AbortController>,
): Promise<unknown> {
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
    case "readResource": {
      const requestId = args[1] === undefined ? undefined : text(args[1])
      return requestId && onResourceProgress
        ? api.readResource(resource(args[0]), { onProgress: progress => onResourceProgress(requestId, progress) })
        : api.readResource(resource(args[0]))
    }
    case "saveResource": return api.saveResource(resource(args[0]))
    case "openResource":
    case "revealResource": {
      const action = api[method]
      if (!action) throw new Error(method === "openResource" ? "Opening local files is unavailable" : "Revealing local files is unavailable")
      return action.call(api, resource(args[0]))
    }
    case "uploadAttachment": {
      if (!api.uploadAttachment) throw new Error("Attachment upload is unavailable")
      const requestId = args[1] === undefined ? undefined : text(args[1])
      if (!requestId) return api.uploadAttachment(attachmentUpload(args[0]))
      const controller = uploads ? new AbortController() : undefined
      if (controller && uploads) uploads.set(requestId, controller)
      try {
        return await api.uploadAttachment(attachmentUpload(args[0]), {
          ...(onResourceProgress ? { onProgress: progress => onResourceProgress(requestId, progress) } : {}),
          ...(controller ? { signal: controller.signal } : {}),
        })
      } finally {
        uploads?.delete(requestId)
      }
    }
    case "abortAttachmentUpload": {
      uploads?.get(text(args[0]))?.abort()
      return null
    }
    default: throw new Error("Unknown file operation")
  }
}

/** Session IDs are local to a Team registration; bare local targets have no such authority. */
export async function localSessionDirectory(_sessionId: string): Promise<string> {
  throw new Error("Session resources require an authorized Team and Machine target")
}

export const localSessionAttachmentDirectory = localSessionDirectory
export const localDraftAttachmentDirectory = localSessionDirectory

/** Main owns queues; each renderer document receives its own revocable authority. */
export function installFiles(central: CentralApi): { close(): Promise<void> } {
  const owners = new Map<WebContents, WindowFiles>()
  const uploadsByOwner = new Map<WebContents, Map<string, AbortController>>()
  const watched = new Map<WebContents, () => void>()
  const closing = new Set<Promise<void>>()
  let closed = false
  const retire = (contents: WebContents) => {
    const previous = owners.get(contents)
    owners.delete(contents)
    for (const controller of uploadsByOwner.get(contents)?.values() ?? []) controller.abort()
    uploadsByOwner.delete(contents)
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
      isLocalTarget: target => isLocalFileTarget(central, async () => {
        const daemon = await DaemonClient.connect(() => {}, () => {})
        try { return await daemon.call("centralStatus", {}) }
        finally { daemon.close() }
      }, target),
      openPath: async path => {
        const error = await shell.openPath(path)
        if (error) throw new Error(error)
      },
      revealPath: async path => shell.showItemInFolder(path),
      sessionDirectory: localSessionDirectory,
      sessionAttachmentDirectory: localSessionAttachmentDirectory,
      draftAttachmentDirectory: localDraftAttachmentDirectory,
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
    const contents = event.sender
    const current = owner(contents)
    let uploads = uploadsByOwner.get(contents)
    if (!uploads) {
      uploads = new Map()
      uploadsByOwner.set(contents, uploads)
    }
    return invokeFiles(current, method, args, (requestId, progress) => {
      if (owners.get(contents) === current && !contents.isDestroyed()) {
        contents.send(FILES_RESOURCE_PROGRESS_EVENT, { requestId, ...progress })
      }
    }, uploads)
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
