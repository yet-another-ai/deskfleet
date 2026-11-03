import type { AgentInput } from "../../../../apps/daemon/src/agent-protocol.ts"
import { truncateGeneratedTitle } from "../../../../apps/daemon/src/titles.ts"
import { filePathToUri, type FileEntry, type FilesApi, type FileTarget } from "../../../client/src/files.ts"

export const PASTED_TEXT_LINE_THRESHOLD = 25
export const PASTED_TEXT_CHAR_THRESHOLD = 1500

export type ComposerAttachment =
  | { id: string; kind: "image"; name: string; mimeType: string; data: string; size: number }
  | { id: string; kind: "pasted_text"; text: string; lines: number }
  | { id: string; kind: "local_file"; name: string; mimeType?: string; size: number; bytes: Uint8Array; uploadedUri?: string }
  | { id: string; kind: "machine_file"; name: string; path: string; uri: string; size?: number }

export function countLines(text: string): number {
  return text.split(/\r\n|\r|\n/u).length
}

export function shouldFoldPastedText(text: string): boolean {
  if (!text.trim()) return false
  return text.length >= PASTED_TEXT_CHAR_THRESHOLD || countLines(text) >= PASTED_TEXT_LINE_THRESHOLD
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
      result.push({
        id: crypto.randomUUID(),
        kind: "image",
        name: file.name || "image.png",
        mimeType: file.type || "image/png",
        data: bytesToBase64(bytes),
        size: bytes.byteLength,
      })
    } else {
      result.push({
        id: crypto.randomUUID(),
        kind: "local_file",
        name: file.name || "attachment",
        ...(file.type ? { mimeType: file.type } : {}),
        size: bytes.byteLength,
        bytes,
      })
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

export async function buildPromptContent(params: {
  draft: string
  attachments: ComposerAttachment[]
  sessionId: string
  target?: FileTarget
  filesApi?: FilesApi | null
}): Promise<AgentInput["content"]> {
  const blocks: AgentInput["content"] = []
  for (const item of params.attachments) {
    if (item.kind === "image") {
      blocks.push({ type: "image", mimeType: item.mimeType, data: item.data })
    } else if (item.kind === "pasted_text") {
      blocks.push({
        type: "resource",
        resource: { uri: `deskfleet://pasted-text/${item.id}.txt`, mimeType: "text/plain", text: item.text },
      })
    } else if (item.kind === "machine_file") {
      blocks.push({
        type: "resource_link",
        uri: item.uri,
        name: item.name,
        ...(item.size !== undefined ? { size: item.size } : {}),
      })
    } else if (item.kind === "local_file") {
      if (!item.uploadedUri) {
        if (!params.filesApi?.uploadAttachment || !params.target) throw new Error("File transfer is unavailable for this machine.")
        const uploaded = await params.filesApi.uploadAttachment({
          target: params.target,
          sessionId: params.sessionId,
          name: item.name,
          data: item.bytes,
        })
        item.uploadedUri = uploaded.uri
      }
      blocks.push({
        type: "resource_link",
        uri: item.uploadedUri,
        name: item.name,
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
        size: item.size,
      })
    }
  }
  if (params.draft.trim()) {
    blocks.push({ type: "text", text: params.draft })
  }
  return blocks
}
