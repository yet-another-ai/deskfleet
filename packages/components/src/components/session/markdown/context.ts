import katex from "katex"
import type { InjectionKey } from "vue"

export interface LoadedImage {
  url?: string
  error?: string
  refCount: number
}

export interface MarkdownHostApi {
  useImage: (uri: string) => LoadedImage | undefined
  retainImage: (uri: string) => void
  releaseImage: (uri: string) => void
  allocateDiagramId: (indexKey: string) => string
}

export const markdownHostKey: InjectionKey<MarkdownHostApi> = Symbol("deskfleet-markdown-host")

const mathCache = new Map<string, { ok: boolean; html: string }>()

export function renderCachedMath(tex: string, displayMode: boolean): { ok: boolean; html: string } {
  const key = `${displayMode ? "B" : "I"}:${tex}`
  const hit = mathCache.get(key)
  if (hit) return hit
  try {
    const html = katex.renderToString(tex, { displayMode, throwOnError: true, strict: "ignore", trust: false })
    const res = { ok: true, html }
    if (mathCache.size > 2000) mathCache.clear()
    mathCache.set(key, res)
    return res
  } catch {
    return { ok: false, html: "" }
  }
}
