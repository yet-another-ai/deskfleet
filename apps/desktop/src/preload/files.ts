import { ipcRenderer } from "electron"
import { FILES_CHANGED_EVENT, FILES_IPC_CHANNEL, type FilesApi, type FileTransfer } from "@deskfleet/client/files"

/** Calls and transfer snapshots cross the sandbox; disk and RTC handles stay in main. */
export function filesApi(): FilesApi {
  const invoke = <T>(method: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(FILES_IPC_CHANNEL, method, args) as Promise<T>
  return {
    list: (target, path) => invoke("list", target, path),
    chooseLocalDirectory: () => invoke("chooseLocalDirectory"),
    enqueue: request => invoke("enqueue", request),
    transfers: () => invoke("transfers"),
    cancel: id => invoke("cancel", id),
    retry: (id, conflict) => invoke("retry", id, conflict),
    resolveResource: request => invoke("resolveResource", request),
    readResource: request => invoke("readResource", request),
    saveResource: request => invoke("saveResource", request),
    onChanged: listener => {
      const handler = (_event: Electron.IpcRendererEvent, transfers: FileTransfer[]) => listener(transfers)
      ipcRenderer.on(FILES_CHANGED_EVENT, handler)
      return () => ipcRenderer.removeListener(FILES_CHANGED_EVENT, handler)
    },
  }
}
