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
export interface FilesApi {
  list(target: FileTarget, path?: string): Promise<FileListing>
  /** A browser grants access to a local directory; desktop opens a native directory chooser. */
  chooseLocalDirectory(): Promise<FileListing | null>
  /** Desktop asks for trusted consent to preview the Session's captured local directory. */
  authorizeLocalSession?(sessionId: string): Promise<FileTarget | null>
  enqueue(request: FileTransferRequest): Promise<string>
  transfers(): Promise<FileTransfer[]>
  cancel(id: string): Promise<void>
  retry(id: string, conflict?: FileConflict): Promise<void>
  onChanged(listener: (transfers: FileTransfer[]) => void): () => void
  resolveResource(request: FileResourceRequest): Promise<FileEntry>
  /** Bounded image/text preview; larger files use saveResource and the streaming transfer queue. */
  readResource(request: FileResourceRequest): Promise<{ data: Uint8Array; name: string; mimeType: string }>
  saveResource(request: FileResourceRequest): Promise<string | null>
}
export const FILES_IPC_CHANNEL = "deskfleet:files"
export const FILES_CHANGED_EVENT = "deskfleet:files-changed"
