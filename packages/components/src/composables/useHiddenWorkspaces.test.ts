import { afterEach, expect, test } from "vitest"
import { effectScope, nextTick, ref } from "vue"
import { createHiddenWorkspaces, HIDDEN_WORKSPACES_STORAGE_KEY } from "./useHiddenWorkspaces.ts"

afterEach(() => localStorage.clear())

test("persists hidden workspace IDs across reloads while keeping machine reveal state ephemeral", async () => {
  const scope = effectScope()
  try {
    const state = scope.run(() => createHiddenWorkspaces("team-1"))!
    expect(state.isHidden("machine-a", "ws-1")).toBe(false)
    expect(state.hasHidden("machine-a")).toBe(false)

    state.hide("machine-a", "ws-1")
    state.hide("machine-a", "ws-2")
    state.hide("machine-a", "ws-1")
    expect(state.hiddenIds("machine-a")).toEqual(["ws-1", "ws-2"])
    expect(state.isHidden("machine-a", "ws-1")).toBe(true)
    expect(state.hasHidden("machine-a")).toBe(true)

    // Viewing hidden workspaces on machine-a does not unhide them and does not persist across restart.
    state.setShowingHidden("machine-a", true)
    expect(state.isShowingHidden("machine-a")).toBe(true)
    expect(state.isHidden("machine-a", "ws-1")).toBe(true)
    expect(state.isHidden("machine-a", "ws-2")).toBe(true)

    await nextTick()
    const reloaded = scope.run(() => createHiddenWorkspaces("team-1"))!
    expect(reloaded.hiddenIds("machine-a")).toEqual(["ws-1", "ws-2"])
    expect(reloaded.isShowingHidden("machine-a")).toBe(false)

    // Unhiding one workspace leaves the other hidden and keeps reveal mode active until none remain.
    reloaded.setShowingHidden("machine-a", true)
    reloaded.unhide("machine-a", "ws-1")
    expect(reloaded.isHidden("machine-a", "ws-1")).toBe(false)
    expect(reloaded.isHidden("machine-a", "ws-2")).toBe(true)
    expect(reloaded.isShowingHidden("machine-a")).toBe(true)

    reloaded.unhide("machine-a", "ws-2")
    expect(reloaded.hiddenIds("machine-a")).toEqual([])
    expect(reloaded.hasHidden("machine-a")).toBe(false)
    expect(reloaded.isShowingHidden("machine-a")).toBe(false)
    await nextTick()
    expect(JSON.parse(localStorage.getItem(HIDDEN_WORKSPACES_STORAGE_KEY)!)).toEqual({})
  } finally {
    scope.stop()
  }
})

test("isolates hidden workspaces and reveal state by Team scope and Machine ID even with equal workspace IDs", () => {
  const scope = effectScope()
  try {
    const team = ref("team-a")
    const state = scope.run(() => createHiddenWorkspaces(team))!

    state.hide("machine-1", "7")
    expect(state.isHidden("machine-1", "7")).toBe(true)
    expect(state.isHidden("machine-2", "7")).toBe(false)

    state.hide("machine-2", "7")
    state.setShowingHidden("machine-1", true)
    expect(state.isShowingHidden("machine-1")).toBe(true)
    expect(state.isShowingHidden("machine-2")).toBe(false)

    state.unhide("machine-1", "7")
    expect(state.isHidden("machine-1", "7")).toBe(false)
    expect(state.isHidden("machine-2", "7")).toBe(true)

    state.setShowingHidden("machine-2", true)
    team.value = "team-b"
    expect(state.isHidden("machine-2", "7")).toBe(false)
    expect(state.isShowingHidden("machine-2")).toBe(false)

    state.hide("machine-2", "9")
    team.value = "team-a"
    expect(state.hiddenIds("machine-2")).toEqual(["7"])
    team.value = "team-b"
    expect(state.hiddenIds("machine-2")).toEqual(["9"])
  } finally {
    scope.stop()
  }
})

test("sanitizes corrupted or malformed localStorage values without throwing", () => {
  localStorage.setItem(HIDDEN_WORKSPACES_STORAGE_KEY, "{not-json")
  const scope = effectScope()
  try {
    const malformed = scope.run(() => createHiddenWorkspaces("local"))!
    expect(malformed.hiddenIds("machine-1")).toEqual([])

    localStorage.setItem(HIDDEN_WORKSPACES_STORAGE_KEY, JSON.stringify({
      local: { "machine-1": ["ws-1", "", 42, "ws-1"], bad: "nope" },
      broken: [],
    }))
    const sanitized = scope.run(() => createHiddenWorkspaces("local"))!
    expect(sanitized.hiddenIds("machine-1")).toEqual(["ws-1"])
  } finally {
    scope.stop()
  }
})
