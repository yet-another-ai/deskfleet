import { ref } from "vue"
import type { SearchKind } from "@deskfleet/client/search"
import { useMachineRuntimes } from "./useMachineRuntimes.ts"
import { useLayoutStore } from "../stores/layout.ts"

export type SidebarPanel = "conversations" | "schedules" | "desktops" | "search"

export function panelForRouteName(name: unknown): SidebarPanel | undefined {
  if (name === "schedules") return "schedules"
  if (name === "remote-desktops") return "desktops"
  if (name === "search") return "search"
  return undefined
}

export function createSidebarPanel(initial: SidebarPanel = "conversations") {
  const panel = ref<SidebarPanel>(initial)
  const searchQuery = ref("")
  const searchKind = ref<SearchKind>("all")

  function reset(): void {
    panel.value = "conversations"
    searchQuery.value = ""
    searchKind.value = "all"
  }

  return { panel, searchQuery, searchKind, reset }
}

export type SidebarPanelState = ReturnType<typeof createSidebarPanel>

/** Shared across the host sidebar and every mounted remote machine surface. */
export const useSidebarPanel = (): SidebarPanelState =>
  useMachineRuntimes()?.sidebarPanel ?? useLayoutStore().sidebarPanel
