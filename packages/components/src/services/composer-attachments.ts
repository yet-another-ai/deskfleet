import { reactive } from "vue"
import type { AgentInput } from "../../../../apps/daemon/src/agent-protocol.ts"
import { truncateGeneratedTitle } from "../../../../apps/daemon/src/titles.ts"
import { filePathToUri, type FileEntry, type FilesApi, type FileTarget } from "../../../client/src/files.ts"

export const PASTED_TEXT_LINE_THRESHOLD = 25
export const PASTED_TEXT_CHAR_THRESHOLD = 1500

export type ComposerAttachment =
  | { id: string; kind: "image"; name: string; mimeType: string; data: string; size: number }
  | { id: string; kind: "pasted_text"; text: string; lines: number }
  | { id: string; kind: "local_file"; name: string; mimeType?: string; size: number; bytes: Uint8Array; uploadedUri?: string; uploadedTargetKey?: string }
  | { id: string; kind: "machine_file"; name: string; path: string; uri: string; size?: number }

export interface AttachmentUploadState {
  status: "uploading" | "uploaded" | "error"
  transferredBytes: number
  totalBytes: number
  progress: number
  targetKey: string
  uri?: string
  error?: string
}

const uploadStates = reactive(new Map<string, AttachmentUploadState>())
const activeUploads = new Map<string, { targetKey: string; controller: AbortController }>()

export function attachmentTargetKey(target: FileTarget | undefined): string | undefined {
  if (!target) return undefined
  return target.kind === "local" ? `local:${target.grantId ?? ""}` : `machine:${target.teamId}:${target.machineId}`
}

export function isAttachmentUploadedForTarget(
  item: Extract<ComposerAttachment, { kind: "local_file" }>,
  target: FileTarget | undefined,
): boolean {
  const key = attachmentTargetKey(target)
  const tracked = uploadStates.get(item.id)
  if (tracked && (!key || tracked.targetKey === key) && tracked.status === "uploaded" && tracked.uri) {
    item.uploadedUri ??= tracked.uri
    item.uploadedTargetKey ??= tracked.targetKey
    return true
  }
  return !!item.uploadedUri && (!item.uploadedTargetKey || (!!key && item.uploadedTargetKey === key))
}

export function getAttachmentUploadState(item: ComposerAttachment, target: FileTarget | undefined): AttachmentUploadState | undefined {
  if (item.kind !== "local_file") return undefined
  if (isAttachmentUploadedForTarget(item, target)) {
    return {
      status: "uploaded",
      transferredBytes: item.size,
      totalBytes: item.size,
      progress: 1,
      targetKey: attachmentTargetKey(target) ?? item.uploadedTargetKey ?? "",
      uri: item.uploadedUri,
    }
  }
  const state = uploadStates.get(item.id)
  const key = attachmentTargetKey(target)
  return state && (!key || state.targetKey === key) ? state : undefined
}

export function hasIncompleteAttachmentUploads(attachments: readonly ComposerAttachment[], target: FileTarget | undefined): boolean {
  return attachments.some(item => item.kind === "local_file" && !isAttachmentUploadedForTarget(item, target))
}

export function cancelAttachmentUpload(id: string): void {
  activeUploads.get(id)?.controller.abort()
  activeUploads.delete(id)
  uploadStates.delete(id)
}

function startAttachmentUpload(
  item: Extract<ComposerAttachment, { kind: "local_file" }>,
  target: FileTarget,
  targetKey: string,
  sessionId: string | undefined,
  filesApi: FilesApi,
): void {
  if (!filesApi.uploadAttachment) return
  cancelAttachmentUpload(item.id)
  if (item.uploadedTargetKey && item.uploadedTargetKey !== targetKey) {
    item.uploadedUri = undefined
    item.uploadedTargetKey = undefined
  }
  const controller = new AbortController()
  const state: AttachmentUploadState = reactive({
    status: "uploading",
    transferredBytes: 0,
    totalBytes: item.size,
    progress: item.size === 0 ? 1 : 0,
    targetKey,
  })
  uploadStates.set(item.id, state)
  activeUploads.set(item.id, { targetKey, controller })
  void filesApi.uploadAttachment(
    { target, ...(sessionId ? { sessionId } : { draftId: item.id }), name: item.name, data: item.bytes },
    {
      signal: controller.signal,
      onProgress: ({ transferredBytes, totalBytes }) => {
        if (controller.signal.aborted || uploadStates.get(item.id) !== state) return
        state.transferredBytes = transferredBytes
        state.totalBytes = totalBytes
        state.progress = totalBytes > 0 ? Math.max(0, Math.min(1, transferredBytes / totalBytes)) : 1
      },
    },
  ).then(uploaded => {
    if (controller.signal.aborted) return
    item.uploadedUri = uploaded.uri
    item.uploadedTargetKey = targetKey
    if (uploadStates.get(item.id) === state) {
      Object.assign(state, { status: "uploaded", transferredBytes: item.size, totalBytes: item.size, progress: 1, uri: uploaded.uri })
    }
  }).catch(reason => {
    if (controller.signal.aborted || uploadStates.get(item.id) !== state) return
    state.status = "error"
    state.error = reason instanceof Error ? reason.message : String(reason)
  }).finally(() => {
    if (activeUploads.get(item.id)?.controller === controller) activeUploads.delete(item.id)
  })
}

export function retryAttachmentUpload(params: {
  item: Extract<ComposerAttachment, { kind: "local_file" }>
  target: FileTarget | undefined
  sessionId?: string
  filesApi: FilesApi | null | undefined
}): void {
  const key = attachmentTargetKey(params.target)
  if (!params.target || !key || !params.filesApi?.uploadAttachment) return
  params.item.uploadedUri = undefined
  params.item.uploadedTargetKey = undefined
  startAttachmentUpload(params.item, params.target, key, params.sessionId, params.filesApi)
}

export function syncAttachmentUploads(params: {
  attachments: readonly ComposerAttachment[]
  target: FileTarget | undefined
  sessionId?: string
  filesApi: FilesApi | null | undefined
}): void {
  const key = attachmentTargetKey(params.target)
  if (!params.target || !key || !params.filesApi?.uploadAttachment) return
  for (const item of params.attachments) {
    if (item.kind !== "local_file" || isAttachmentUploadedForTarget(item, params.target)) continue
    if (activeUploads.get(item.id)?.targetKey === key) continue
    const state = uploadStates.get(item.id)
    if (state?.targetKey === key && state.status === "error") continue
    startAttachmentUpload(item, params.target, key, params.sessionId, params.filesApi)
  }
}

export function countLines(text: string): number {
  return text.split(/\r\n|\r|\n/u).length
}

export function shouldFoldPastedText(text: string): boolean {
  return Boolean(text.trim()) && (text.length >= PASTED_TEXT_CHAR_THRESHOLD || countLines(text) >= PASTED_TEXT_LINE_THRESHOLD)
}

export function createPastedTextAttachment(text: string): ComposerAttachment {
  return { id: crypto.randomUUID(), kind: "pasted_text", text, lines: countLines(text) }
}

export function pathToFileUri(filePath: string): string {
  return /^file:\/\//iu.test(filePath) ? filePath : filePathToUri(filePath)
}

export function createMachineFileAttachment(entry: Pick<FileEntry, "name" | "path" | "size">): ComposerAttachment {
  return { id: crypto.randomUUID(), kind: "machine_file", name: entry.name, path: entry.path, uri: pathToFileUri(entry.path), size: entry.size }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

export async function attachmentsFromFiles(files: Iterable<File>): Promise<ComposerAttachment[]> {
  const result: ComposerAttachment[] = []
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (file.type.startsWith("image/")) {
      result.push({ id: crypto.randomUUID(), kind: "image", name: file.name || "image.png", mimeType: file.type || "image/png", data: bytesToBase64(bytes), size: bytes.byteLength })
    } else {
      result.push({ id: crypto.randomUUID(), kind: "local_file", name: file.name || "attachment", ...(file.type ? { mimeType: file.type } : {}), size: bytes.byteLength, bytes })
    }
  }
  return result
}

export function hasSubmittableText(draft: string, attachments: readonly ComposerAttachment[]): boolean {
  return Boolean(draft.trim()) || attachments.some(item => item.kind === "pasted_text" && Boolean(item.text.trim()))
}

export function sessionTitleFromDraft(draft: string, attachments: readonly ComposerAttachment[]): string {
  const trimmed = draft.trim()
  if (trimmed) return truncateGeneratedTitle(trimmed.split(/\r\n|\r|\n/u)[0]!)
  const pasted = attachments.find((item): item is Extract<ComposerAttachment, { kind: "pasted_text" }> => item.kind === "pasted_text" && Boolean(item.text.trim()))
  return truncateGeneratedTitle(pasted?.text.trim().split(/\r\n|\r|\n/u)[0] ?? "Session")
}

function attachmentToBlock(item: ComposerAttachment, uri?: string): AgentInput["content"][number] {
  if (item.kind === "image") return { type: "image", mimeType: item.mimeType, data: item.data }
  if (item.kind === "pasted_text") return { type: "resource", resource: { uri: `deskfleet://pasted-text/${item.id}.txt`, mimeType: "text/plain", text: item.text } }
  if (item.kind === "machine_file") return { type: "resource_link", uri: item.uri, name: item.name, ...(item.size !== undefined ? { size: item.size } : {}) }
  return {
    type: "resource_link",
    uri: uri ?? item.uploadedUri ?? `file:///attachment/${encodeURIComponent(item.name)}`,
    name: item.name,
    ...(item.mimeType ? { mimeType: item.mimeType } : {}),
    size: item.size,
  }
}

export function previewPromptContent(draft: string, attachments: readonly ComposerAttachment[]): AgentInput["content"] {
  const blocks = attachments.map(item => attachmentToBlock(item))
  if (draft.trim()) blocks.push({ type: "text", text: draft })
  return blocks
}

export async function buildPromptContent(params: {
  draft: string
  attachments: ComposerAttachment[]
  sessionId: string
  target?: FileTarget
  filesApi?: FilesApi | null
}): Promise<AgentInput["content"]> {
  const blocks: AgentInput["content"] = []
  for (const item of params.attachments) {
    if (item.kind === "local_file" && !item.uploadedUri) {
      if (!params.filesApi?.uploadAttachment || !params.target) throw new Error("File transfer is unavailable for this machine.")
      item.uploadedUri = (await params.filesApi.uploadAttachment({ target: params.target, sessionId: params.sessionId, name: item.name, data: item.bytes })).uri
    }
    blocks.push(attachmentToBlock(item, item.kind === "local_file" ? item.uploadedUri : undefined))
  }
  if (params.draft.trim()) blocks.push({ type: "text", text: params.draft })
  return blocks
}
