import { computed, ref, shallowReactive } from "vue"
import { useMachineRuntimes } from "./useMachineRuntimes.ts"
import { useLayoutStore } from "../stores/layout.ts"

export type SidebarSessionFilter = "all" | "unread" | "working"

export function createSidebarFilter() {
  const filter = ref<SidebarSessionFilter>("all")
  const counts = shallowReactive(new Map<string, { unread: number; working: number }>())
  const sum = (key: "unread" | "working") => [...counts.values()].reduce((total, item) => total + item[key], 0)
  return { filter, counts, totalUnread: computed(() => sum("unread")), totalWorking: computed(() => sum("working")) }
}

export type SidebarFilterState = ReturnType<typeof createSidebarFilter>

/** Shared across the host sidebar and every mounted remote machine surface. */
export const useSidebarFilter = () => useMachineRuntimes()?.sidebarFilter ?? useLayoutStore().sidebarFilter
