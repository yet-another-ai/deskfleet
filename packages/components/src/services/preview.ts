import { type Component, type InjectionKey } from "vue"
import type { FileResourceRequest } from "../../../client/src/files.ts"

export type OfficePreviewKind = "docx" | "xlsx" | "pptx"
export type PreviewKind = "mermaid" | "image" | "audio" | "video" | "model" | OfficePreviewKind
export type MediaPreviewKind = Exclude<PreviewKind, "mermaid">
export type PreviewMode = "inline" | "focus" | "tab" | "window"

export interface PreviewToolbarAction {
  id: string
  icon: Component
  label: string
  onClick: () => void
}

export const registerPreviewActionsKey: InjectionKey<(actions: PreviewToolbarAction[]) => void> = Symbol("registerPreviewActions")

export interface PreviewSource {
  sessionId?: string
  entryId?: string
  itemId?: string
}

export interface PreviewDescriptor {
  kind: PreviewKind
  content: string
  title?: string
  alt?: string
  mimeType?: string
  source?: PreviewSource
  resourceRequest?: FileResourceRequest
}

/** Local grants belong to one renderer document and cannot authorize another window. */
export function previewResourceRequestToQuery(request?: FileResourceRequest): Record<string, string | undefined> {
  const machine = request?.target.kind === "machine" ? request.target : undefined
  return {
    fileTarget: machine ? "machine" : undefined,
    fileTeamId: machine?.teamId,
    fileMachineId: machine?.machineId,
    fileSessionId: machine ? request?.sessionId : undefined,
    fileUri: machine ? request?.uri : undefined,
  }
}

/** Keep explicit scope on navigation; main/the daemon still authorize every request. */
export function previewResourceRequestFromQuery(get: (key: string) => unknown): FileResourceRequest | undefined {
  if (get("fileTarget") !== "machine") return undefined
  const text = (key: string) => {
    const value = get(key)
    return typeof value === "string" && value.length > 0 && value.length <= 32768 && !value.includes("\0") ? value : undefined
  }
  const teamId = text("fileTeamId"), machineId = text("fileMachineId")
  const sessionId = text("fileSessionId"), uri = text("fileUri")
  if (!teamId || !machineId || !sessionId || !uri) return undefined
  return { target: { kind: "machine", teamId, machineId }, sessionId, uri }
}

export function isPannablePreview(kind: PreviewKind): boolean {
  return kind === "mermaid" || kind === "image"
}

export function previewKindFromMime(mime?: string | null): MediaPreviewKind | undefined {
  if (!mime) return undefined
  const clean = mime.split(";")[0]!.trim().toLowerCase()
  if (clean.startsWith("image/")) return "image"
  if (clean.startsWith("audio/")) return "audio"
  if (clean.startsWith("video/")) return "video"
  if (clean.startsWith("model/")) return "model"
  if (clean === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx"
  if (clean === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx"
  if (clean === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx"
  return undefined
}

export function previewKindFromUri(uri: string, explicitMime?: string | null): MediaPreviewKind | undefined {
  const fromExplicit = previewKindFromMime(explicitMime)
  if (fromExplicit) return fromExplicit
  const dataMatch = uri.match(/^data:([^;,]+)[;,]/iu)
  if (dataMatch) return previewKindFromMime(dataMatch[1])
  const extension = uri.replace(/[?#].*$/u, "").split(".").pop()?.toLowerCase()
  if (/^(?:apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)$/u.test(extension ?? "")) return "image"
  if (/^(?:aac|flac|m4a|mp3|oga|ogg|opus|wav|weba)$/u.test(extension ?? "")) return "audio"
  if (/^(?:m4v|mov|mp4|ogv|webm)$/u.test(extension ?? "")) return "video"
  if (/^(?:3mf|fbx|glb|gltf|obj|stl)$/u.test(extension ?? "")) return "model"
  if (extension === "docx" || extension === "xlsx" || extension === "pptx") return extension
  return undefined
}

export function resolvePreviewKind(content: string, explicitKind?: string | null, explicitMime?: string | null): PreviewKind {
  if (explicitKind === "mermaid" || explicitKind === "image" || explicitKind === "audio" || explicitKind === "video" || explicitKind === "model" || explicitKind === "docx" || explicitKind === "xlsx" || explicitKind === "pptx") {
    return explicitKind
  }
  const fromUri = previewKindFromUri(content, explicitMime)
  if (fromUri) return fromUri
  if (/^(?:blob:|https?:\/\/)/iu.test(content)) return "image"
  return "mermaid"
}
