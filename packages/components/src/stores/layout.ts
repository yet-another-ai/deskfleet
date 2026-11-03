import { useBreakpoints, useLocalStorage } from "@vueuse/core"
import { defineStore } from "pinia"
import { computed, nextTick, onScopeDispose, ref, shallowRef, watch } from "vue"
import type { AgentSessionContext } from "../../../../apps/daemon/src/agent-protocol.ts"
import { router } from "../router/index.ts"
import { usePlatformClient } from "../composables/usePlatformClient.ts"
import type { PreviewDescriptor } from "../services/preview.ts"

export interface MermaidSource { sessionId?: string; entryId?: string; diagramId?: string }
export interface MermaidLocateRequest extends MermaidSource { id: number; code: string }
export type SessionWindowRequest =
  | { id: number; kind: "preview"; item: PreviewDescriptor }
  | { id: number; kind: "mermaid"; code: string; source?: MermaidSource }
type NewSessionWindowRequest =
  | { kind: "preview"; item: PreviewDescriptor }
  | { kind: "mermaid"; code: string; source?: MermaidSource }

export const pendingMermaidLocate = ref<MermaidLocateRequest | null>(null)
const MERMAID_LOCATE_CHANNEL = "deskfleet.mermaid-locate"
let nextId = 1
let nextWindowRequestId = 1
let locatedTimer: ReturnType<typeof setTimeout> | undefined

export function performMermaidLocateDom(request: MermaidLocateRequest | null = pendingMermaidLocate.value): boolean {
  if (!request || typeof document === "undefined") return false
  const entryEl = request.entryId ? document.querySelector<HTMLElement>(`[data-conversation-entry=${JSON.stringify(request.entryId)}]`) : null
  if (request.entryId && !entryEl) return false
  const candidates = [...(entryEl ?? document).querySelectorAll<HTMLElement>("[data-mermaid]")].filter(
    el => !el.dataset.mermaidMode || el.dataset.mermaidMode === "inline",
  )
  const target = (request.diagramId && candidates.find(el => el.dataset.mermaid === request.diagramId))
    || candidates.find(el => el.dataset.mermaidCode === request.code)
    || entryEl
  if (!target) return false
  if (pendingMermaidLocate.value?.id === request.id) pendingMermaidLocate.value = null
  clearTimeout(locatedTimer)
  for (const prev of document.querySelectorAll<HTMLElement>("[data-mermaid-located]")) delete prev.dataset.mermaidLocated
  target.dataset.mermaidLocated = "true"
  target.scrollIntoView?.({ behavior: "smooth", block: "center" })
  locatedTimer = setTimeout(() => { delete target.dataset.mermaidLocated }, 1600)
  return true
}

export async function locateMermaidInMainView(code: string, source?: MermaidSource): Promise<boolean> {
  const request: MermaidLocateRequest = { id: nextId++, code, ...source }
  pendingMermaidLocate.value = request
  const current = router.currentRoute.value
  if (source?.sessionId && (current.name !== "session" || current.params.sessionId !== source.sessionId || current.query.mermaid !== undefined)) {
    await router.push({ name: "session", params: { sessionId: source.sessionId }, query: {} })
  } else if (current.query.mermaid !== undefined) {
    await router.push({ path: current.path, query: { ...current.query, mermaid: undefined, mermaidEntry: undefined, mermaidDiagram: undefined } })
  }
  await nextTick()
  return performMermaidLocateDom(request) || (await nextTick(), performMermaidLocateDom(request))
}

export function broadcastMermaidLocate(code: string, source?: MermaidSource): void {
  try {
    const channel = new BroadcastChannel(MERMAID_LOCATE_CHANNEL)
    channel.postMessage({ code, source })
    channel.close()
  } catch { /* BroadcastChannel is optional in non-browser environments. */ }
}

export function listenMermaidLocate(handler: (code: string, source?: MermaidSource) => void): () => void {
  try {
    const channel = new BroadcastChannel(MERMAID_LOCATE_CHANNEL)
    channel.onmessage = ({ data }) => { if (typeof data?.code === "string") handler(data.code, data.source) }
    return () => channel.close()
  } catch {
    return () => {}
  }
}

export const useLayoutStore = defineStore("layout", () => {
  // Per-device preferences; they fall back to the defaults when storage is unavailable.
  const desktopSidebarOpen = useLocalStorage("deskfleet.sidebar-open", true)
  const sidebarWidth = useLocalStorage("deskfleet.sidebar-width", 260)
  const compact = useBreakpoints({ desktop: 1024 }).smaller("desktop")
  const compactPanel = ref<"sidebar" | "details" | null>(null)
  const sessionWindowRequest = shallowRef<SessionWindowRequest>()
  const sessionWindowsAvailable = computed(() => router.currentRoute.value.name === "session")
  const sidebarOpen = computed({
    get: () => compact.value ? compactPanel.value === "sidebar" : desktopSidebarOpen.value,
    set: value => {
      if (!compact.value) desktopSidebarOpen.value = value
      else if (value) compactPanel.value = "sidebar"
      else if (compactPanel.value === "sidebar") compactPanel.value = null
    },
  })
  const detailsOpen = computed(() => compactPanel.value === "details")
  function closeCompactPanel(): void { compactPanel.value = null }
  watch(compact, closeCompactPanel)
  onScopeDispose(router.afterEach(closeCompactPanel))
  /** Machine-local destinations survive view remounts without leaking to another machine. */
  const conversationPath = usePlatformClient().target ? ref("/") : useLocalStorage("deskfleet.conversation-path", "/")
  /** The execution context a new Session uses; the last choice is remembered. */
  const sessionContext = useLocalStorage<AgentSessionContext>("deskfleet.session-context", "directory")
  /** The Session terminal panel below the conversation. */
  const terminalPanelOpen = useLocalStorage("deskfleet.terminal-panel-open", false)
  const terminalPanelHeight = useLocalStorage("deskfleet.terminal-panel-height", 280)

  function toggleSidebar(): void { sidebarOpen.value = !sidebarOpen.value }
  function toggleDetails(): void {
    compactPanel.value = detailsOpen.value ? null : "details"
  }
  function requestSessionWindow(request: NewSessionWindowRequest): boolean {
    if (!sessionWindowsAvailable.value) return false
    const routeSessionId = router.currentRoute.value.params.sessionId
    const sourceSessionId = request.kind === "preview" ? request.item.source?.sessionId : request.source?.sessionId
    if (sourceSessionId && sourceSessionId !== routeSessionId) return false
    sessionWindowRequest.value = { id: nextWindowRequestId++, ...request } as SessionWindowRequest
    return true
  }

  return {
    compact,
    closeCompactPanel,
    sidebarOpen,
    sidebarWidth,
    detailsOpen,
    sessionWindowsAvailable,
    sessionWindowRequest,
    conversationPath,
    sessionContext,
    terminalPanelOpen,
    terminalPanelHeight,
    toggleSidebar,
    toggleDetails,
    requestSessionWindow,
  }
})
