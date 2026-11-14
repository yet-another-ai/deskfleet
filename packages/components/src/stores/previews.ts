import { getActivePinia } from "pinia"
import { nextTick, ref } from "vue"
import type { RouteLocationNormalizedLoadedGeneric } from "vue-router"
import { router } from "../router/index.ts"
import { previewResourceRequestFromQuery, previewResourceRequestToQuery, resolvePreviewKind, type PreviewDescriptor, type PreviewSource } from "../services/preview.ts"
import { springScrollIntoView } from "../services/spring-scroll.ts"
import { useLayoutStore, type ResourceWindowItem } from "./layout.ts"

export interface PreviewLocateRequest extends PreviewSource {
  id: number
  content: string
}

export const pendingPreviewLocate = ref<PreviewLocateRequest | null>(null)

const PREVIEW_WINDOW_CHANNEL = "deskfleet.preview-window"
let nextLocateRequestId = 1
let locatedTimer: ReturnType<typeof setTimeout> | undefined

export async function focusPreview(item: PreviewDescriptor): Promise<void> {
  const layout = useLayoutStore()
  if (layout.compact && layout.requestSessionWindow({ kind: "preview", item })) return
  layout.sidebarOpen = true
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
      ...previewResourceRequestToQuery(item.resourceRequest),
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
  const resourceRequest = previewResourceRequestFromQuery(key => route.query[key])
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
    ...(resourceRequest ? { resourceRequest } : {}),
  }
}

/** Session renderers open previews as desktop tabs or mobile views. */
export function openPreviewFromAction(item: PreviewDescriptor): boolean {
  if (!getActivePinia()) return false
  return useLayoutStore().requestSessionWindow({ kind: "preview", item })
}

/** Session resource links open in a preview tab first and resolve workspace/type inside the tab. */
export function openResourceFromAction(item: ResourceWindowItem): boolean {
  if (!getActivePinia()) return false
  const clean: ResourceWindowItem = {
    request: {
      target: { ...item.request.target },
      sessionId: item.request.sessionId,
      uri: item.request.uri,
    },
    ...(item.title ? { title: item.title } : {}),
    ...(item.source ? { source: { ...item.source } } : {}),
  }
  return useLayoutStore().requestSessionWindow({ kind: "resource", item: clean })
}

export function performPreviewLocateDom(request: PreviewLocateRequest | null = pendingPreviewLocate.value): boolean {
  if (!request) return false
  const entryEl = request.entryId
    ? document.querySelector<HTMLElement>(`[data-conversation-entry=${JSON.stringify(request.entryId)}]`)
    : null
  if (request.entryId && !entryEl) return false
  const scope = entryEl ?? document
  const candidates = [...scope.querySelectorAll<HTMLElement>("[data-preview]")].filter(
    element => !element.dataset.previewMode || element.dataset.previewMode === "inline",
  )
  const resourceLinks = [...scope.querySelectorAll<HTMLElement>("[data-resource-link]")]
  const target = (request.itemId && candidates.find(element => element.dataset.preview === request.itemId))
    || candidates.find(element => element.dataset.previewContent === request.content)
    || (request.itemId && resourceLinks.find(element => element.dataset.resourceLink === request.itemId))
    || resourceLinks.find(element => element.dataset.resourceLink === request.content)
    || entryEl
  if (!target) return false
  if (pendingPreviewLocate.value?.id === request.id) pendingPreviewLocate.value = null
  clearTimeout(locatedTimer)
  for (const previous of document.querySelectorAll<HTMLElement>("[data-preview-located]")) delete previous.dataset.previewLocated
  target.dataset.previewLocated = "true"
  springScrollIntoView(target)
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
        ...previewResourceRequestToQuery(),
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

export function broadcastPreviewTab(item: PreviewDescriptor): void {
  broadcast({ type: "tab", item })
}

export function listenPreviewWindowMessages(
  locate: (content: string, source?: PreviewSource) => void,
): () => void {
  try {
    const channel = new BroadcastChannel(PREVIEW_WINDOW_CHANNEL)
    channel.onmessage = ({ data }) => {
      if (data?.type === "tab" && data.item && typeof data.item.content === "string") {
        openPreviewFromAction(data.item as PreviewDescriptor)
      } else if (data?.type === "locate" && typeof data.content === "string") {
        locate(data.content, data.source)
      }
    }
    return () => channel.close()
  } catch {
    return () => {}
  }
}
