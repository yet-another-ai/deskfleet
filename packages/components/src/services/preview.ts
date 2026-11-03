import { type Component, type InjectionKey } from "vue"

export type PreviewKind = "mermaid" | "image" | "audio" | "video" | "model"
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
  return undefined
}

export function resolvePreviewKind(content: string, explicitKind?: string | null, explicitMime?: string | null): PreviewKind {
  if (explicitKind === "mermaid" || explicitKind === "image" || explicitKind === "audio" || explicitKind === "video" || explicitKind === "model") {
    return explicitKind
  }
  const fromUri = previewKindFromUri(content, explicitMime)
  if (fromUri) return fromUri
  if (/^(?:blob:|https?:\/\/)/iu.test(content)) return "image"
  return "mermaid"
}
