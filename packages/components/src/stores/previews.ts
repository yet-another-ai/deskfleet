import { nextTick, ref } from "vue"
import type { RouteLocationNormalizedLoadedGeneric } from "vue-router"
import { router } from "../router/index.ts"
import { resolvePreviewKind, type PreviewDescriptor, type PreviewSource } from "../services/preview.ts"
import { activeDetailsTab, useLayoutStore } from "./layout.ts"

export interface PreviewLocateRequest extends PreviewSource {
  id: number
  content: string
}

export interface PreviewSidebarTab extends PreviewDescriptor {
  id: string
}

export const previewSidebarTabs = ref<PreviewSidebarTab[]>([])
export const pendingPreviewLocate = ref<PreviewLocateRequest | null>(null)

const PREVIEW_WINDOW_CHANNEL = "deskfleet.preview-window"
let nextSidebarTabId = 1
let nextLocateRequestId = 1
let locatedTimer: ReturnType<typeof setTimeout> | undefined

export async function focusPreview(item: PreviewDescriptor): Promise<void> {
  useLayoutStore().sidebarOpen = true
  const current = router.currentRoute.value
  await router.push({
    path: current.path,
    query: {
      ...current.query,
      preview: item.content,
      previewEntry: item.source?.entryId,
      previewItem: item.source?.itemId,
      previewKind: item.kind,
      previewTitle: item.title || undefined,
      previewMime: item.mimeType || undefined,
    },
  })
}

export function focusedPreviewFromRoute(
  route: Pick<RouteLocationNormalizedLoadedGeneric, "params" | "query">,
): PreviewDescriptor | undefined {
  const query = (key: string) => {
    const value = route.query[key]
    return typeof value === "string" && value ? value : undefined
  }
  const content = query("preview")
  if (!content) return undefined
  const explicitKind = query("previewKind")
  const mimeType = query("previewMime")
  const title = query("previewTitle")
  const entryId = query("previewEntry")
  const itemId = query("previewItem")
  const kind = resolvePreviewKind(content, explicitKind, mimeType)
  const source: PreviewSource = {
    ...(typeof route.params.sessionId === "string" && route.params.sessionId ? { sessionId: route.params.sessionId } : {}),
    ...(entryId ? { entryId } : {}),
    ...(itemId ? { itemId } : {}),
  }
  return {
    kind,
    content,
    ...(title ? { title } : {}),
    ...(mimeType ? { mimeType } : {}),
    source,
  }
}

export function openPreviewInSidebar(item: PreviewDescriptor): string {
  const existing = previewSidebarTabs.value.find(tab => tab.content === item.content && tab.kind === item.kind)
  if (existing) {
    existing.source = { ...existing.source, ...item.source }
    if (item.title) existing.title = item.title
    if (item.mimeType) existing.mimeType = item.mimeType
    activeDetailsTab.value = existing.id
  } else {
    const tab: PreviewSidebarTab = { ...item, id: `preview-${nextSidebarTabId++}` }
    previewSidebarTabs.value = [...previewSidebarTabs.value, tab]
    activeDetailsTab.value = tab.id
  }
  useLayoutStore().detailsOpen = true
  return activeDetailsTab.value
}

export function closePreviewSidebarTab(id: string): void {
  const index = previewSidebarTabs.value.findIndex(tab => tab.id === id)
  if (index === -1) return
  const next = previewSidebarTabs.value.filter(tab => tab.id !== id)
  previewSidebarTabs.value = next
  if (activeDetailsTab.value === id) activeDetailsTab.value = next[Math.min(index, next.length - 1)]?.id ?? "changes"
}

export function performPreviewLocateDom(request: PreviewLocateRequest | null = pendingPreviewLocate.value): boolean {
  if (!request) return false
  const entryEl = request.entryId
    ? document.querySelector<HTMLElement>(`[data-conversation-entry=${JSON.stringify(request.entryId)}]`)
    : null
  if (request.entryId && !entryEl) return false
  const candidates = [...(entryEl ?? document).querySelectorAll<HTMLElement>("[data-preview]")].filter(
    element => !element.dataset.previewMode || element.dataset.previewMode === "inline",
  )
  const target = (request.itemId && candidates.find(element => element.dataset.preview === request.itemId))
    || candidates.find(element => element.dataset.previewContent === request.content)
    || entryEl
  if (!target) return false
  if (pendingPreviewLocate.value?.id === request.id) pendingPreviewLocate.value = null
  clearTimeout(locatedTimer)
  for (const previous of document.querySelectorAll<HTMLElement>("[data-preview-located]")) delete previous.dataset.previewLocated
  target.dataset.previewLocated = "true"
  target.scrollIntoView?.({ behavior: "smooth", block: "center" })
  locatedTimer = setTimeout(() => { delete target.dataset.previewLocated }, 1600)
  return true
}

export async function locatePreviewInMainView(content: string, source?: PreviewSource): Promise<boolean> {
  const request: PreviewLocateRequest = { id: nextLocateRequestId++, content, ...source }
  pendingPreviewLocate.value = request
  const current = router.currentRoute.value
  if (source?.sessionId && (current.name !== "session" || current.params.sessionId !== source.sessionId || current.query.preview !== undefined)) {
    await router.push({ name: "session", params: { sessionId: source.sessionId }, query: {} })
  } else if (current.query.preview !== undefined) {
    await router.push({
      path: current.path,
      query: {
        ...current.query,
        preview: undefined,
        previewEntry: undefined,
        previewItem: undefined,
        previewKind: undefined,
        previewTitle: undefined,
        previewMime: undefined,
      },
    })
  }
  await nextTick()
  return performPreviewLocateDom(request)
}

function broadcast(message: object): void {
  try {
    const channel = new BroadcastChannel(PREVIEW_WINDOW_CHANNEL)
    channel.postMessage(message)
    channel.close()
  } catch { /* BroadcastChannel is optional in non-browser environments. */ }
}

export function broadcastPreviewLocate(content: string, source?: PreviewSource): void {
  broadcast({ type: "locate", content, source })
}

export function broadcastPreviewSidebar(item: PreviewDescriptor): void {
  broadcast({ type: "sidebar", item })
}

export function listenPreviewWindowMessages(
  locate: (content: string, source?: PreviewSource) => void,
): () => void {
  try {
    const channel = new BroadcastChannel(PREVIEW_WINDOW_CHANNEL)
    channel.onmessage = ({ data }) => {
      if (data?.type === "sidebar" && data.item && typeof data.item.content === "string") {
        openPreviewInSidebar(data.item as PreviewDescriptor)
      } else if (data?.type === "locate" && typeof data.content === "string") {
        locate(data.content, data.source)
      }
    }
    return () => channel.close()
  } catch {
    return () => {}
  }
}
