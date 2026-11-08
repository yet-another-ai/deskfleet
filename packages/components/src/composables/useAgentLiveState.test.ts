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
