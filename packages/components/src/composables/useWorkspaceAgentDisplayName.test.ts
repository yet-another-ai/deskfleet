import { effectScope, nextTick, ref } from "vue"
import { afterEach, expect, test } from "vitest"
import {
  DEFAULT_WORKSPACE_AGENT_DISPLAY_NAME,
  MAX_WORKSPACE_AGENT_DISPLAY_NAME_LENGTH,
  normalizeWorkspaceAgentDisplayName,
  resolveWorkspaceAgentDisplayName,
  useWorkspaceAgentDisplayName,
  WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY,
} from "./useWorkspaceAgentDisplayName.ts"

afterEach(() => {
  localStorage.removeItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY)
})

test("defaults to Super Agent without writing defaults to localStorage", () => {
  const scope = effectScope()
  try {
    const state = scope.run(() => useWorkspaceAgentDisplayName())!
    expect(state.customName.value).toBe("")
    expect(state.displayName.value).toBe(DEFAULT_WORKSPACE_AGENT_DISPLAY_NAME)
    expect(localStorage.getItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY)).toBeNull()
  } finally {
    scope.stop()
  }
})

test("normalizes, persists, syncs live across instances, and clears on blank/whitespace values", async () => {
  const scopeA = effectScope()
  const scopeB = effectScope()
  try {
    const a = scopeA.run(() => useWorkspaceAgentDisplayName())!
    const b = scopeB.run(() => useWorkspaceAgentDisplayName())!

    a.customName.value = "  Jarvis 助手  "
    expect(a.customName.value).toBe("Jarvis 助手")
    expect(a.displayName.value).toBe("Jarvis 助手")
    expect(localStorage.getItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY)).toBe("Jarvis 助手")
    expect(b.displayName.value).toBe("Jarvis 助手")

    // Reopen / fresh scope reads persisted value from localStorage.
    const scopeReopen = effectScope()
    try {
      const reopened = scopeReopen.run(() => useWorkspaceAgentDisplayName())!
      expect(reopened.customName.value).toBe("Jarvis 助手")
      expect(reopened.displayName.value).toBe("Jarvis 助手")
    } finally {
      scopeReopen.stop()
    }

    // Whitespace-only input clears storage and restores default name live.
    a.customName.value = "   \t\n  "
    await nextTick()
    expect(localStorage.getItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY)).toBeNull()
    expect(a.customName.value).toBe("")
    expect(a.displayName.value).toBe("Super Agent")
    expect(b.displayName.value).toBe("Super Agent")

    // Saving literal "null" still persists and syncs properly.
    a.customName.value = "null"
    await nextTick()
    expect(localStorage.getItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY)).toBe("null")
    expect(b.displayName.value).toBe("null")

    // Empty string restores default.
    a.customName.value = ""
    await nextTick()
    expect(localStorage.getItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY)).toBeNull()
    expect(b.displayName.value).toBe("Super Agent")

    // Cross-window storage events sync updates and clears immediately.
    window.dispatchEvent(new StorageEvent("storage", {
      key: WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY,
      newValue: "  跨窗口名称  ",
    }))
    expect(a.displayName.value).toBe("跨窗口名称")
    expect(b.displayName.value).toBe("跨窗口名称")

    window.dispatchEvent(new StorageEvent("storage", {
      key: WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY,
      newValue: null,
    }))
    expect(a.displayName.value).toBe("Super Agent")
    expect(b.displayName.value).toBe("Super Agent")
  } finally {
    scopeA.stop()
    scopeB.stop()
  }
})

test("falls back cleanly for whitespace-only stored data, respects custom fallback ref, and clamps length", () => {
  localStorage.setItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY, "   ")
  const fallback = ref("Super Agent")
  const scope = effectScope()
  try {
    const state = scope.run(() => useWorkspaceAgentDisplayName(fallback))!
    expect(state.customName.value).toBe("")
    expect(state.displayName.value).toBe("Super Agent")

    const longName = `  ${"A".repeat(MAX_WORKSPACE_AGENT_DISPLAY_NAME_LENGTH + 20)}  `
    expect(normalizeWorkspaceAgentDisplayName(longName)).toHaveLength(MAX_WORKSPACE_AGENT_DISPLAY_NAME_LENGTH)
    expect(resolveWorkspaceAgentDisplayName("   ", "Super Agent")).toBe("Super Agent")
    expect(resolveWorkspaceAgentDisplayName(undefined, "Super Agent")).toBe("Super Agent")
  } finally {
    scope.stop()
  }
})
