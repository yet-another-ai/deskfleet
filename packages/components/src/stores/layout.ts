import { useBreakpoints, useLocalStorage } from "@vueuse/core"
import { defineStore } from "pinia"
import { computed, markRaw, onScopeDispose, ref, shallowRef, watch } from "vue"
import type { AgentSessionContext } from "@deskfleet/protocol/agent"
import type { FileResourceRequest } from "@deskfleet/client/files"
import { parseSessionWindowHash } from "@deskfleet/client/session-window"
import { router } from "../router/index.ts"
import { usePlatformClient } from "../composables/usePlatformClient.ts"
import { createHiddenWorkspaces } from "../composables/useHiddenWorkspaces.ts"
import { createSidebarFilter } from "../composables/useSidebarFilter.ts"
import { createSidebarOrder } from "../composables/useSidebarOrder.ts"
import { createSidebarPanel, panelForRouteName } from "../composables/useSidebarPanel.ts"
import type { PreviewDescriptor, PreviewSource } from "../services/preview.ts"

export interface ResourceWindowItem {
  request: FileResourceRequest
  title?: string
  source?: PreviewSource
}
export type SessionWindowRequest =
  | { id: number; kind: "preview"; item: PreviewDescriptor }
  | { id: number; kind: "resource"; item: ResourceWindowItem }
type NewSessionWindowRequest =
  | { kind: "preview"; item: PreviewDescriptor }
  | { kind: "resource"; item: ResourceWindowItem }

let nextWindowRequestId = 1

export const useLayoutStore = defineStore("layout", () => {
  const sidebarOrder = markRaw(createSidebarOrder())
  const hiddenWorkspaces = markRaw(createHiddenWorkspaces())
  const standaloneSession = ref(
    (typeof window !== "undefined" && parseSessionWindowHash(window.location.hash) !== undefined)
      || router.currentRoute.value.query.window === "session",
  )
  // Per-device preferences; they fall back to the defaults when storage is unavailable.
  const desktopSidebarOpen = useLocalStorage("deskfleet.sidebar-open", true)
  const sidebarWidth = useLocalStorage("deskfleet.sidebar-width", 260)
  const compact = useBreakpoints({ desktop: 1024 }).smaller("desktop")
  const compactPanel = ref<"sidebar" | "details" | null>(null)
  const detailsOpenRequest = ref(0)
  const sessionWindowRequest = shallowRef<SessionWindowRequest>()
  const sessionWindowsAvailable = computed(() => router.currentRoute.value.name === "session")
  const sidebarOpen = computed({
    get: () => standaloneSession.value ? false : compact.value ? compactPanel.value === "sidebar" : desktopSidebarOpen.value,
    set: value => {
      if (standaloneSession.value) return
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
  /** Non-persistent filter shared in local-only mode when MachineRuntimes is absent. */
  const sidebarFilter = markRaw(createSidebarFilter())
  /** Active sidebar panel in local-only mode when MachineRuntimes is absent. */
  const sidebarPanel = markRaw(createSidebarPanel(panelForRouteName(router.currentRoute.value.name) ?? "conversations"))

  function toggleSidebar(): void {
    if (standaloneSession.value) return
    sidebarOpen.value = !sidebarOpen.value
  }
  function toggleDetails(): void {
    compactPanel.value = detailsOpen.value ? null : "details"
  }
  function requestDetailsOpen(): void {
    if (compact.value) compactPanel.value = "details"
    else detailsOpenRequest.value++
  }
  function requestSessionWindow(request: NewSessionWindowRequest): boolean {
    if (!sessionWindowsAvailable.value) return false
    const routeSessionId = router.currentRoute.value.params.sessionId
    const sourceSessionId = request.item.source?.sessionId
      ?? (request.kind === "resource" ? request.item.request.sessionId : undefined)
    if (sourceSessionId && sourceSessionId !== routeSessionId) return false
    sessionWindowRequest.value = { id: nextWindowRequestId++, ...request } as SessionWindowRequest
    return true
  }

  return {
    compact,
    closeCompactPanel,
    standaloneSession,
    sidebarOpen,
    sidebarWidth,
    detailsOpen,
    detailsOpenRequest,
    sessionWindowsAvailable,
    sessionWindowRequest,
    conversationPath,
    sessionContext,
    terminalPanelOpen,
    terminalPanelHeight,
    sidebarFilter,
    sidebarOrder,
    hiddenWorkspaces,
    sidebarPanel,
    toggleSidebar,
    toggleDetails,
    requestDetailsOpen,
    requestSessionWindow,
  }
})
