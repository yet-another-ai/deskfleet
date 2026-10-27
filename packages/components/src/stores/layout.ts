import { useLocalStorage } from "@vueuse/core"
import { defineStore } from "pinia"
import { nextTick, ref } from "vue"
import type { AgentSessionContext } from "../../../../apps/daemon/src/agent-protocol.ts"
import { router } from "../router/index.ts"

export interface MermaidSource { sessionId?: string; entryId?: string; diagramId?: string }
export interface MermaidLocateRequest extends MermaidSource { id: number; code: string }
export interface MermaidSidebarTab { id: string; code: string; source?: MermaidSource }

export const mermaidSidebarTabs = ref<MermaidSidebarTab[]>([])
export const activeDetailsTab = ref("changes")
export const pendingMermaidLocate = ref<MermaidLocateRequest | null>(null)
const MERMAID_LOCATE_CHANNEL = "deskfleet.mermaid-locate"
let nextId = 1
let locatedTimer: ReturnType<typeof setTimeout> | undefined

export function openMermaidSidebarTab(code: string, source?: MermaidSource): string {
  const existing = mermaidSidebarTabs.value.find(tab => tab.code === code)
  if (existing) {
    if (source) existing.source = { ...existing.source, ...source }
    return (activeDetailsTab.value = existing.id)
  }
  const tab: MermaidSidebarTab = { id: `mermaid-${nextId++}`, code, ...(source ? { source } : {}) }
  mermaidSidebarTabs.value = [...mermaidSidebarTabs.value, tab]
  return (activeDetailsTab.value = tab.id)
}

export function closeMermaidSidebarTab(id: string): void {
  const index = mermaidSidebarTabs.value.findIndex(tab => tab.id === id)
  if (index === -1) return
  const next = mermaidSidebarTabs.value.filter(tab => tab.id !== id)
  mermaidSidebarTabs.value = next
  if (activeDetailsTab.value === id) activeDetailsTab.value = next[Math.min(index, next.length - 1)]?.id ?? "changes"
}

export function resetMermaidSidebarTabs(): void {
  mermaidSidebarTabs.value = []
  activeDetailsTab.value = "changes"
  pendingMermaidLocate.value = null
  nextId = 1
}

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
  const sidebarOpen = useLocalStorage("deskfleet.sidebar-open", true)
  const sidebarWidth = useLocalStorage("deskfleet.sidebar-width", 260)
  const detailsOpen = useLocalStorage("deskfleet.details-open", true)
  const detailsWidth = useLocalStorage("deskfleet.details-width", 288)
  /** Last Conversations destination; survives sidebar remounts (hide/show, Settings). */
  const conversationPath = useLocalStorage("deskfleet.conversation-path", "/")
  /** The execution context a new Session uses; the last choice is remembered. */
  const sessionContext = useLocalStorage<AgentSessionContext>("deskfleet.session-context", "worktree")
  /** The Session terminal panel below the conversation. */
  const terminalPanelOpen = useLocalStorage("deskfleet.terminal-panel-open", false)
  const terminalPanelHeight = useLocalStorage("deskfleet.terminal-panel-height", 280)

  function toggleSidebar(): void { sidebarOpen.value = !sidebarOpen.value }
  function toggleDetails(): void { detailsOpen.value = !detailsOpen.value }
  function openMermaidInSidebar(code: string, source?: MermaidSource): string {
    detailsOpen.value = true
    return openMermaidSidebarTab(code, source)
  }

  return {
    sidebarOpen,
    sidebarWidth,
    detailsOpen,
    detailsWidth,
    conversationPath,
    sessionContext,
    terminalPanelOpen,
    terminalPanelHeight,
    mermaidTabs: mermaidSidebarTabs,
    activeDetailsTab,
    toggleSidebar,
    toggleDetails,
    openMermaidInSidebar,
    closeMermaidTab: closeMermaidSidebarTab,
  }
})
