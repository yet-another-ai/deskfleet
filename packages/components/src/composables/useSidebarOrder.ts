import { useLocalStorage } from "@vueuse/core"
import { computed, shallowRef, toValue, watch, type MaybeRefOrGetter } from "vue"
import { useLayoutStore } from "../stores/layout.ts"
import { useMachineRuntimes } from "./useMachineRuntimes.ts"

export const machineOrderGroup = "machines"
export const pinnedSessionOrderGroup = "pinned-sessions"
export const workspaceOrderGroup = (machineId: string) => JSON.stringify(["workspaces", machineId])
export const sessionOrderGroup = (machineId: string, workspaceId?: string) => JSON.stringify(["sessions", machineId, workspaceId])

export function createSidebarOrder(scope: MaybeRefOrGetter<string> = "local") {
  const savedOrders = useLocalStorage<Record<string, Record<string, string[]>>>(
    "deskfleet.sidebar-order", {}, { writeDefaults: false, flush: "post" },
  )
  const groups = computed(() => savedOrders.value[toValue(scope)])
  const drag = shallowRef<{ group: string; id: string } | null>(null)
  watch(() => toValue(scope), () => { drag.value = null }, { flush: "sync" })

  function ordered<T extends { id: string }>(group: string, items: readonly T[]): readonly T[] {
    const saved = groups.value?.[group]
    if (!saved?.length) return items
    const rank = new Map(saved.map((id, index) => [id, index]))
    return items.toSorted((a, b) => (rank.get(a.id) ?? saved.length) - (rank.get(b.id) ?? saved.length))
  }

  function move(group: string, items: readonly { id: string }[], sourceId: string, targetId: string, edge: "before" | "after"): boolean {
    const current = ordered(group, items).map(item => item.id)
    const sourceIndex = current.indexOf(sourceId)
    const targetIndex = current.indexOf(targetId)
    const offset = edge === "after" ? 1 : 0
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex || sourceIndex === targetIndex + (offset ? 1 : -1)) return false

    // Keep ranks for temporarily unavailable items so a restored Session keeps its place.
    const saved = new Set(groups.value?.[group])
    for (const id of current) saved.add(id)
    saved.delete(sourceId)
    const next = [...saved]
    next.splice(next.indexOf(targetId) + offset, 0, sourceId)
    savedOrders.value = { ...savedOrders.value, [toValue(scope)]: { ...groups.value, [group]: next } }
    return true
  }

  return { ordered, move, drag }
}

export type SidebarOrder = ReturnType<typeof createSidebarOrder>

/** The host sidebar and opened machine surfaces use the same preference and drag state. */
export const useSidebarOrder = () => useMachineRuntimes()?.sidebarOrder ?? useLayoutStore().sidebarOrder
