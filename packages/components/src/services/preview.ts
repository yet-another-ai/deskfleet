import { type Component, type ComputedRef, type InjectionKey } from "vue"
import type { FileResourceRequest } from "@deskfleet/client/files"

export type OfficePreviewKind = "docx" | "xlsx" | "pptx"
export type PreviewView = "source" | "markdown" | "html" | "mermaid" | "image" | "audio" | "video" | "model" | "csv" | OfficePreviewKind
export type PreviewKind = Exclude<PreviewView, "source">
export type MediaPreviewKind = "image" | "audio" | "video" | "model" | "csv" | OfficePreviewKind
export type PreviewMode = "inline" | "focus" | "tab" | "window" | "dialog"

export interface PreviewFormat {
  id: string
  mediaKind?: MediaPreviewKind
  mimes?: readonly string[]
  mimePrefixes?: readonly string[]
  extensions?: readonly string[]
  /** Supported views in priority order; views[0] is the default without a #L anchor. */
  views: readonly PreviewView[]
}

export const PREVIEW_FORMATS: readonly PreviewFormat[] = [
  { id: "markdown", mimes: ["text/markdown"], extensions: ["md", "markdown"], views: ["source", "markdown"] },
  { id: "html", mimes: ["text/html"], extensions: ["html", "htm"], views: ["source", "html"] },
  { id: "svg", mediaKind: "image", mimes: ["image/svg+xml"], extensions: ["svg"], views: ["image", "source"] },
  { id: "csv", mediaKind: "csv", mimes: ["text/csv"], extensions: ["csv"], views: ["csv", "source"] },
  { id: "mermaid", extensions: ["mmd", "mermaid"], views: ["mermaid", "source"] },
  { id: "image", mediaKind: "image", mimePrefixes: ["image/"], extensions: ["apng", "avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "webp"], views: ["image"] },
  { id: "audio", mediaKind: "audio", mimePrefixes: ["audio/"], extensions: ["aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "weba"], views: ["audio"] },
  { id: "video", mediaKind: "video", mimePrefixes: ["video/"], extensions: ["m4v", "mov", "mp4", "ogv", "webm"], views: ["video"] },
  { id: "model", mediaKind: "model", mimePrefixes: ["model/"], extensions: ["3mf", "fbx", "glb", "gltf", "obj", "stl"], views: ["model"] },
  { id: "docx", mediaKind: "docx", mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"], extensions: ["docx"], views: ["docx"] },
  { id: "xlsx", mediaKind: "xlsx", mimes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], extensions: ["xlsx"], views: ["xlsx"] },
  { id: "pptx", mediaKind: "pptx", mimes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"], extensions: ["pptx"], views: ["pptx"] },
]

const FORMAT_BY_ID = new Map(PREVIEW_FORMATS.map(format => [format.id, format]))

export interface PreviewToolbarAction {
  id: string
  icon: Component
  label: string
  onClick: () => void
  pressed?: boolean
}

export const registerPreviewActionsKey: InjectionKey<(actions: PreviewToolbarAction[]) => void> = Symbol("registerPreviewActions")
export const conversationEntryIdKey: InjectionKey<ComputedRef<string | undefined>> = Symbol("conversationEntryId")

export function previewDefaultTitle(
  kind: PreviewKind | undefined,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (kind === "mermaid") return t("mermaid.title")
  if (kind === "image") return t("agent.image")
  return t("agent.contentType", { type: kind ?? "file" })
}

export interface PreviewSource { sessionId?: string; entryId?: string; itemId?: string }

export interface PreviewDescriptor {
  kind: PreviewKind
  content?: string
  text?: string
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
    fileBasePath: machine ? request?.basePath : undefined,
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
  const request: FileResourceRequest = { target: { kind: "machine", teamId, machineId }, sessionId, uri }
  const rawBasePath = get("fileBasePath")
  if (rawBasePath !== undefined && rawBasePath !== null) {
    const basePath = text("fileBasePath")
    if (!basePath) return undefined
    request.basePath = basePath
  }
  return request
}

export function isPannablePreview(kind: PreviewKind): boolean {
  return kind === "mermaid" || kind === "image"
}

function formatFromMime(mime?: string | null): PreviewFormat | undefined {
  if (!mime) return undefined
  const clean = mime.split(";")[0]!.trim().toLowerCase()
  return PREVIEW_FORMATS.find(f => f.mimes?.includes(clean))
    ?? PREVIEW_FORMATS.find(f => f.mimePrefixes?.some(prefix => clean.startsWith(prefix)))
}

function formatFromUri(uri: string, explicitMime?: string | null, mediaOnly = false): PreviewFormat | undefined {
  const pick = (format?: PreviewFormat) => (format && (!mediaOnly || format.mediaKind) ? format : undefined)
  const fromExplicit = pick(formatFromMime(explicitMime))
  if (fromExplicit) return fromExplicit
  const dataMatch = uri.match(/^data:([^;,]+)[;,]/iu)
  if (dataMatch) return pick(formatFromMime(dataMatch[1]))
  const clean = uri.replace(/[?#].*$/u, "")
  const name = clean.split(/[\\/]/u).pop() ?? clean
  const dot = name.lastIndexOf(".")
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined
  return ext ? pick(PREVIEW_FORMATS.find(f => f.extensions?.includes(ext))) : undefined
}

export function previewKindFromMime(mime?: string | null): MediaPreviewKind | undefined {
  return formatFromMime(mime)?.mediaKind
}

export function previewKindFromUri(uri: string, explicitMime?: string | null): MediaPreviewKind | undefined {
  return formatFromUri(uri, explicitMime, true)?.mediaKind
}

export function resolvePreviewKind(content: string, explicitKind?: string | null, explicitMime?: string | null): PreviewKind {
  const explicit = explicitKind ? FORMAT_BY_ID.get(explicitKind) : undefined
  if (explicit) return (explicit.mediaKind ?? explicit.id) as PreviewKind
  const fromUri = previewKindFromUri(content, explicitMime)
  if (fromUri) return fromUri
  return /^(?:blob:|https?:\/\/)/iu.test(content) ? "image" : "mermaid"
}

export function resolvePreviewFormat(nameOrUri: string, explicitMime?: string | null, explicitKind?: string | null): PreviewFormat | undefined {
  const fromUri = formatFromUri(nameOrUri, explicitMime)
  if (fromUri && (!explicitKind || fromUri.id === explicitKind || fromUri.mediaKind === explicitKind)) return fromUri
  return (explicitKind ? FORMAT_BY_ID.get(explicitKind) : undefined) ?? fromUri
}

export function resolveAvailableViews(format: PreviewFormat | undefined, hasText: boolean): readonly PreviewView[] {
  const views = format?.views ?? (["source"] as const)
  const filtered = hasText ? views : views.filter(view => view !== "source")
  return filtered.length ? filtered : views
}

export function resolveInitialView(views: readonly PreviewView[], hasLineAnchor: boolean): PreviewView {
  return (hasLineAnchor && views.includes("source")) ? "source" : (views[0] ?? "source")
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true })

export function decodeUtf8Text(data: Uint8Array): string | undefined {
  try {
    const text = utf8Decoder.decode(data)
    return text.includes("\0") ? undefined : text
  } catch { return undefined }
}

export function decodeDataUrlText(url: string): string | undefined {
  const comma = url.startsWith("data:") ? url.indexOf(",") : -1
  if (comma < 0) return undefined
  const body = url.slice(comma + 1)
  try {
    if (url.slice(5, comma).includes(";base64")) {
      const binary = atob(body)
      return decodeUtf8Text(Uint8Array.from(binary, ch => ch.charCodeAt(0)))
    }
    const text = decodeURIComponent(body)
    return text.includes("\0") ? undefined : text
  } catch { return undefined }
}
