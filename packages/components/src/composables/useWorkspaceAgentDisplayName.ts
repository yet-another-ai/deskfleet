import { computed, ref, toValue, type MaybeRefOrGetter } from "vue"

export const WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY = "deskfleet.workspace-agent.display-name"
export const DEFAULT_WORKSPACE_AGENT_DISPLAY_NAME = "Super Agent"
export const MAX_WORKSPACE_AGENT_DISPLAY_NAME_LENGTH = 64

export function normalizeWorkspaceAgentDisplayName(value: unknown): string {
  if (typeof value !== "string") return ""
  return value.trim().slice(0, MAX_WORKSPACE_AGENT_DISPLAY_NAME_LENGTH).trim()
}

export function resolveWorkspaceAgentDisplayName(
  value: unknown,
  fallback = DEFAULT_WORKSPACE_AGENT_DISPLAY_NAME,
): string {
  return normalizeWorkspaceAgentDisplayName(value) || fallback
}

function readStoredDisplayName(): string {
  if (typeof localStorage === "undefined") return ""
  try {
    return normalizeWorkspaceAgentDisplayName(localStorage.getItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY))
  } catch {
    return ""
  }
}

function writeStoredDisplayName(normalized: string): void {
  if (typeof localStorage === "undefined") return
  try {
    if (normalized) localStorage.setItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY, normalized)
    else localStorage.removeItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY)
  } catch {
    // Keep the in-memory preference working when storage is unavailable.
  }
}

const sharedCustomName = ref<string>(readStoredDisplayName())
let storageListenerAttached = false

function syncFromStorage(): void {
  const stored = readStoredDisplayName()
  if (sharedCustomName.value !== stored) {
    sharedCustomName.value = stored
  }
}

function ensureStorageListener(): void {
  if (storageListenerAttached || typeof window === "undefined") return
  storageListenerAttached = true
  window.addEventListener("storage", event => {
    if (event.key !== null && event.key !== WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY) return
    const next = event.key === null ? "" : normalizeWorkspaceAgentDisplayName(event.newValue)
    if (sharedCustomName.value !== next) {
      sharedCustomName.value = next
    }
  })
}

/** Viewing-device preference for the Super Agent speaker label in personal project conversations. */
export function useWorkspaceAgentDisplayName(fallback?: MaybeRefOrGetter<string>) {
  ensureStorageListener()
  syncFromStorage()

  const customName = computed({
    get: () => sharedCustomName.value,
    set: (value: string) => {
      const normalized = normalizeWorkspaceAgentDisplayName(value)
      writeStoredDisplayName(normalized)
      sharedCustomName.value = normalized
    },
  })

  const displayName = computed(() => {
    const resolvedFallback = toValue(fallback) || DEFAULT_WORKSPACE_AGENT_DISPLAY_NAME
    return resolveWorkspaceAgentDisplayName(sharedCustomName.value, resolvedFallback)
  })

  return {
    customName,
    displayName,
  }
}
