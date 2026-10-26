import { useLocalStorage } from "@vueuse/core"
import { defineStore } from "pinia"
import type { AgentSessionContext } from "../../../../apps/daemon/src/agent-protocol.ts"

export const useLayoutStore = defineStore("layout", () => {
  // Per-device preferences; they fall back to the defaults when storage is unavailable.
  const sidebarOpen = useLocalStorage("deskfleet.sidebar-open", true)
  const detailsOpen = useLocalStorage("deskfleet.details-open", true)
  /** Last Conversations destination; survives sidebar remounts (hide/show, Settings). */
  const conversationPath = useLocalStorage("deskfleet.conversation-path", "/")
  /** The execution context a new Session uses; the last choice is remembered. */
  const sessionContext = useLocalStorage<AgentSessionContext>("deskfleet.session-context", "worktree")
  /** The Session terminal panel below the conversation. */
  const terminalPanelOpen = useLocalStorage("deskfleet.terminal-panel-open", false)
  const terminalPanelHeight = useLocalStorage("deskfleet.terminal-panel-height", 280)

  function toggleSidebar(): void {
    sidebarOpen.value = !sidebarOpen.value
  }

  function toggleDetails(): void {
    detailsOpen.value = !detailsOpen.value
  }

  return { sidebarOpen, detailsOpen, conversationPath, sessionContext, terminalPanelOpen, terminalPanelHeight, toggleSidebar, toggleDetails }
})
