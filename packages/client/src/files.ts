import type { FileConflict, FileEntry, FileKind, FileListing as DaemonFileListing } from "../../../apps/daemon/src/files-protocol.ts"
export type { FileConflict, FileEntry } from "../../../apps/daemon/src/files-protocol.ts"
/** Desktop grants are opaque main-process capabilities; remote wire listings carry none. */
export type FileListing = DaemonFileListing & { grantId?: string }
export type FileTarget = { kind: "local"; grantId?: string } | { kind: "machine"; machineId: string; teamId: string }
export interface FileLocation { target: FileTarget; path: string }
export interface FileTransferRequest { source: FileLocation; destination: FileLocation; conflict?: FileConflict; kind?: FileKind }
export interface FileTransfer {
  id: string; name: string; kind: FileKind; source: FileLocation; destination: FileLocation
  state: "queued" | "preparing" | "transferring" | "completed" | "failed" | "cancelled" | "conflict"
  transferredBytes: number; totalBytes: number | null; bytesPerSecond: number; error?: string
}
export interface FileResourceRequest { target: FileTarget; sessionId: string; uri: string }
export interface FileAttachmentUploadRequest { target: FileTarget; sessionId: string; name: string; data: Uint8Array }
export interface FileAttachmentUploadResult { path: string; uri: string; name: string; size: number }

export function filePathToUri(path: string): string {
  const normalized = path.replaceAll("\\", "/")
  if (/^[a-z]:\//iu.test(normalized)) {
    const drive = normalized.slice(0, 2)
    const rest = normalized.slice(3).split("/").map(encodeURIComponent).join("/")
    return `file:///${drive}/${rest}`
  }
  if (normalized.startsWith("//")) {
    const parts = normalized.slice(2).split("/").map(encodeURIComponent).join("/")
    return `file://${parts}`
  }
  const clean = normalized.startsWith("/") ? normalized.slice(1) : normalized
  return `file:///${clean.split("/").map(encodeURIComponent).join("/")}`
}

export interface FileReadResourceProgress { transferredBytes: number; totalBytes: number }
export interface FileReadResourceOptions { onProgress?: (progress: FileReadResourceProgress) => void }

export interface FilesApi {
  list(target: FileTarget, path?: string): Promise<FileListing>
  /** A browser grants access to a local directory; desktop opens a native directory chooser. */
  chooseLocalDirectory(): Promise<FileListing | null>
  enqueue(request: FileTransferRequest): Promise<string>
  transfers(): Promise<FileTransfer[]>
  cancel(id: string): Promise<void>
  retry(id: string, conflict?: FileConflict): Promise<void>
  onChanged(listener: (transfers: FileTransfer[]) => void): () => void
  resolveResource(request: FileResourceRequest): Promise<FileEntry>
  /** Bounded image/text preview; larger files use saveResource and the streaming transfer queue. */
  readResource(request: FileResourceRequest, options?: FileReadResourceOptions): Promise<{ data: Uint8Array; name: string; mimeType: string }>
  saveResource(request: FileResourceRequest): Promise<string | null>
  uploadAttachment?(request: FileAttachmentUploadRequest): Promise<FileAttachmentUploadResult>
}
export const FILES_IPC_CHANNEL = "deskfleet:files"
export const FILES_CHANGED_EVENT = "deskfleet:files-changed"
export const FILES_RESOURCE_PROGRESS_EVENT = "deskfleet:files-resource-progress"

