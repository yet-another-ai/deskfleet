import { expect, test } from "vitest"
import { useAgentLiveState } from "./useAgentLiveState.ts"

test("live state ignores previous runs and resets on reconnect without replaying notices", () => {
  const state = useAgentLiveState()
  state.receive({ sessionId: "session", runGeneration: 1, kind: "notice", notice: { id: "first", severity: "warning", title: "Limited" } })
  state.receive({ sessionId: "session", runGeneration: 1, kind: "auth", auth: { kind: "api_key", label: "API key" } })
  state.dismiss("session", "first")
  expect(state.notices.value.session).toEqual([])
  state.receive({ sessionId: "session", runGeneration: 2, kind: "auth", auth: null })
  state.receive({ sessionId: "session", runGeneration: 1, kind: "auth", auth: { kind: "account", label: "Stale" } })
  expect(state.authStatuses.value.session).toBeUndefined()
  state.receive({ sessionId: "session", runGeneration: 2, kind: "notice", notice: { id: "second", severity: "info", title: "Connected" } })
  state.clear()
  expect(state.notices.value).toEqual({})
  expect(state.authStatuses.value).toEqual({})
})

test("an authoritative auth clear replaces a retained identity and later live auth wins", () => {
  const state = useAgentLiveState()
  state.receive({ sessionId: "session", runGeneration: 2, kind: "auth", auth: { kind: "account", label: "Previous account" } })
  // The viewer missed sign-out while detached. Its successful attachment sends
  // this explicit clear before any new live authentication notification.
  state.receive({ sessionId: "session", runGeneration: 2, kind: "auth", auth: null })
  expect(state.authStatuses.value.session).toBeUndefined()
  expect(state.notices.value.session).toBeUndefined()
  state.receive({ sessionId: "session", runGeneration: 3, kind: "auth", auth: { kind: "api_key", label: "Current account" } })
  state.receive({ sessionId: "session", runGeneration: 2, kind: "auth", auth: null })
  expect(state.authStatuses.value.session).toEqual({ kind: "api_key", label: "Current account" })
})
