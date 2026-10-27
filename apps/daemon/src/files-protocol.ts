/** File bytes use their own authorized machine peer, independently of Agent and desktop peers. */
export const FILES_CHANNEL = "deskfleet-files"
// Leave 1 KiB for framing/JSON so ordinary reads and writes fit two 64 KiB
// DataChannel messages instead of producing a tiny third message.
export const FILE_CHUNK_BYTES = 127 * 1024
/** File content being read, queued, or awaiting a write acknowledgement. */
export const FILE_PIPELINE_BYTES = 64 * 1024 * 1024
export const FILE_PIPELINE_CHUNKS = Math.floor(FILE_PIPELINE_BYTES / FILE_CHUNK_BYTES)
export const FILE_MAX_PENDING_REQUESTS = FILE_PIPELINE_CHUNKS + 64
export const FILE_RPC_METADATA_BYTES = 8 * 1024 * 1024
export const FILE_RPC_QUEUE_BYTES = FILE_PIPELINE_BYTES + FILE_RPC_METADATA_BYTES
export const FILE_MAX_OPEN_READS = 32
export type FileKind = "file" | "directory"
export type FileConflict = "ask" | "replace" | "rename" | "skip"
export interface FileEntry { name: string; path: string; kind: FileKind; size: number; modifiedAt: number }
export interface FileListing {
  path: string; parentPath: string | null; homePath: string
  roots: Array<{ name: string; path: string }>; entries: FileEntry[]
}
export interface FileMethods {
  list: { params: { path?: string; strict?: boolean }; result: FileListing }
  stat: { params: { path: string }; result: FileEntry }
  resolve: { params: { sessionId: string; uri: string }; result: FileEntry }
  openRead: { params: { path: string; modifiedAt?: number }; result: { readId: string } }
  read: { params: { path: string; offset: number; length: number; modifiedAt?: number; readId?: string }; result: { bytes: number } }
  closeRead: { params: { readId: string }; result: null }
  begin: { params: { directory?: string; sessionId?: string; name: string; kind: FileKind; conflict: FileConflict }; result: { transferId: string; skipped: boolean } }
  mkdir: { params: { transferId: string; path: string }; result: null }
  write: { params: { transferId: string; path: string; offset: number }; result: { bytes: number } }
  finish: { params: { transferId: string; path: string; size: number }; result: null }
  commit: { params: { transferId: string }; result: { path: string; skipped?: boolean } }
  abort: { params: { transferId: string }; result: null }
}
export type FileMethod = keyof FileMethods
export interface FileReply<T> { value: T; data?: Uint8Array }
export interface FileEndpoint {
  call<M extends FileMethod>(method: M, params: FileMethods[M]["params"], data?: Uint8Array): Promise<FileReply<FileMethods[M]["result"]>>
  close(): Promise<void>
}
