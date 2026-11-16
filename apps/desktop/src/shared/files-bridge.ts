import type { FileAttachmentUploadRequest, FileAttachmentUploadResult, FileReadResourceProgress, FilesApi } from "@deskfleet/client/files"

/** AbortSignal stays in the renderer; only data, IDs, and callbacks cross contextBridge. */
export interface FilesBridge extends Omit<FilesApi, "uploadAttachment"> {
  uploadAttachment(request: FileAttachmentUploadRequest, requestId: string, onProgress?: (progress: FileReadResourceProgress) => void): Promise<FileAttachmentUploadResult>
  abortAttachmentUpload(requestId: string): Promise<void>
}

export function filesBridgeClient(bridge: FilesBridge): FilesApi {
  const { abortAttachmentUpload, ...api } = bridge
  return {
    ...api,
    async uploadAttachment(request, options) {
      const signal = options?.signal
      signal?.throwIfAborted()
      const requestId = crypto.randomUUID()
      const onAbort = () => { void abortAttachmentUpload(requestId).catch(() => {}) }
      signal?.addEventListener("abort", onAbort, { once: true })
      try {
        return await bridge.uploadAttachment(request, requestId, options?.onProgress)
      } finally {
        signal?.removeEventListener("abort", onAbort)
      }
    },
  }
}
