import { useLocalStorage } from "@vueuse/core"
import { computed, hasInjectionContext, ref, toValue, watch, type MaybeRefOrGetter } from "vue"
import { useLayoutStore } from "../stores/layout.ts"
import { useMachineRuntimes } from "./useMachineRuntimes.ts"

export const HIDDEN_WORKSPACES_STORAGE_KEY = "deskfleet.hidden-workspaces"

type StoredHiddenWorkspaces = Record<string, Record<string, string[]>>

function sanitizeStoredHiddenWorkspaces(value: unknown): StoredHiddenWorkspaces {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const result: StoredHiddenWorkspaces = {}
  for (const [scopeKey, machines] of Object.entries(value as Record<string, unknown>)) {
    if (!machines || typeof machines !== "object" || Array.isArray(machines)) continue
    const cleanMachines: Record<string, string[]> = {}
    for (const [machineId, workspaceIds] of Object.entries(machines as Record<string, unknown>)) {
      if (!machineId || !Array.isArray(workspaceIds)) continue
      const unique = [...new Set(workspaceIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
      if (unique.length) cleanMachines[machineId] = unique
    }
    if (Object.keys(cleanMachines).length) result[scopeKey] = cleanMachines
  }
  return result
}

function readStoredHiddenWorkspaces(raw: string): StoredHiddenWorkspaces {
  try {
    return sanitizeStoredHiddenWorkspaces(JSON.parse(raw))
  } catch {
    return {}
  }
}

export function createHiddenWorkspaces(scope: MaybeRefOrGetter<string> = "local") {
  const saved = useLocalStorage<StoredHiddenWorkspaces>(
    HIDDEN_WORKSPACES_STORAGE_KEY,
    {},
    {
      writeDefaults: false,
      flush: "post",
      serializer: {
        read: readStoredHiddenWorkspaces,
        write: JSON.stringify,
      },
    },
  )
  // Per-machine inspection toggle; stays in memory so viewing hidden items never unhides them across restarts.
  const revealedMachineIds = ref(new Set<string>())
  const machines = computed(() => saved.value[toValue(scope)] ?? {})

  watch(() => toValue(scope), () => {
    revealedMachineIds.value = new Set()
  }, { flush: "sync" })

  function hiddenIds(machineId: string): readonly string[] {
    return machines.value[machineId] ?? []
  }

  function isHidden(machineId: string, workspaceId: string): boolean {
    return hiddenIds(machineId).includes(workspaceId)
  }

  function hasHidden(machineId: string): boolean {
    return hiddenIds(machineId).length > 0
  }

  function writeMachineHidden(machineId: string, nextIds: string[]): void {
    const scopeKey = toValue(scope)
    const nextMachines = { ...machines.value }
    if (nextIds.length) nextMachines[machineId] = nextIds
    else delete nextMachines[machineId]

    const nextSaved = { ...saved.value }
    if (Object.keys(nextMachines).length) nextSaved[scopeKey] = nextMachines
    else delete nextSaved[scopeKey]
    saved.value = nextSaved
  }

  function hide(machineId: string, workspaceId: string): void {
    if (!machineId || !workspaceId || isHidden(machineId, workspaceId)) return
    writeMachineHidden(machineId, [...hiddenIds(machineId), workspaceId])
  }

  function unhide(machineId: string, workspaceId: string): void {
    if (!machineId || !workspaceId || !isHidden(machineId, workspaceId)) return
    const nextIds = hiddenIds(machineId).filter(id => id !== workspaceId)
    writeMachineHidden(machineId, nextIds)
    if (nextIds.length === 0 && revealedMachineIds.value.has(machineId)) {
      setShowingHidden(machineId, false)
    }
  }

  function isShowingHidden(machineId: string): boolean {
    return revealedMachineIds.value.has(machineId)
  }

  function setShowingHidden(machineId: string, visible: boolean): void {
    if (!machineId) return
    const has = revealedMachineIds.value.has(machineId)
    if (has === visible) return
    const next = new Set(revealedMachineIds.value)
    if (visible) next.add(machineId)
    else next.delete(machineId)
    revealedMachineIds.value = next
  }

  function toggleShowingHidden(machineId: string): boolean {
    const next = !isShowingHidden(machineId)
    setShowingHidden(machineId, next)
    return next
  }

  return {
    hiddenIds,
    isHidden,
    hasHidden,
    hide,
    unhide,
    isShowingHidden,
    setShowingHidden,
    toggleShowingHidden,
  }
}

export type HiddenWorkspaces = ReturnType<typeof createHiddenWorkspaces>

/** The host sidebar and opened machine surfaces share hidden-workspace preferences and reveal state. */
export const useHiddenWorkspaces = () => (hasInjectionContext() ? useMachineRuntimes()?.hiddenWorkspaces : undefined) ?? useLayoutStore().hiddenWorkspaces
