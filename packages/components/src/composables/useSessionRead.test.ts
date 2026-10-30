import { flushPromises } from "@vue/test-utils"
import { effectScope, nextTick, reactive, ref } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { AgentSessionView } from "../stores/agent-sessions.ts"
import { agentSnapshot } from "../test/agent.ts"
import { deferred } from "../test/desktop-media.ts"
import { useSessionRead } from "./useSessionRead.ts"

const service = reactive({
  state: "connected",
  views: {} as Record<string, AgentSessionView>,
  markRead: vi.fn<(id: string, throughSeq: string) => Promise<void>>(),
})
vi.mock("../stores/agent-sessions.ts", () => ({ useAgentSessionsStore: () => service }))
const scopes: ReturnType<typeof effectScope>[] = []
function setup() {
  const scope = effectScope()
  scopes.push(scope)
  const sessionId = ref("30")
  scope.run(() => useSessionRead(sessionId))
  return { scope, sessionId }
}
function view(completedSeq = "5"): AgentSessionView {
  const snapshot = agentSnapshot()
  snapshot.session.lastCompletedSeq = completedSeq
  return { snapshot, events: [], loading: false, error: null, historySeq: completedSeq, snapshotSeq: completedSeq }
}
function visibility(state: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state)
  document.dispatchEvent(new Event("visibilitychange"))
}
beforeEach(() => {
  service.state = "connected"
  service.views = { "30": view(), "31": view("7") }
  service.markRead.mockReset().mockResolvedValue(undefined)
  visibility("visible")
})
afterEach(() => { for (const scope of scopes.splice(0)) scope.stop() })

test("acknowledges loaded completion once and observes later results while open", async () => {
  setup()
  await flushPromises()
  expect(service.markRead).toHaveBeenCalledExactlyOnceWith("30", "5")
  service.views["30"]!.snapshot!.session.lastReadSeq = "5"
  service.views["30"]!.historySeq = "6"
  await nextTick()
  expect(service.markRead).toHaveBeenCalledTimes(1)
  service.views["30"]!.snapshot!.session.lastCompletedSeq = "9"
  await nextTick()
  expect(service.markRead).toHaveBeenCalledTimes(1)
  service.views["30"]!.historySeq = "10"
  await nextTick()
  expect(service.markRead).toHaveBeenLastCalledWith("30", "9")
})

test("waits for complete history without loading errors", async () => {
  const current = service.views["30"]!
  current.loading = true
  current.historySeq = "3"
  setup()
  await nextTick()
  expect(service.markRead).not.toHaveBeenCalled()
  current.loading = false
  current.error = "History is incomplete"
  current.historySeq = "5"
  await nextTick()
  expect(service.markRead).not.toHaveBeenCalled()
  current.error = null
  await nextTick()
  expect(service.markRead).toHaveBeenCalledExactlyOnceWith("30", "5")
})

test("leaves hidden windows and offline history unread until visible and connected", async () => {
  visibility("hidden")
  setup()
  await nextTick()
  expect(service.markRead).not.toHaveBeenCalled()
  service.state = "idle"
  visibility("visible")
  await nextTick()
  expect(service.markRead).not.toHaveBeenCalled()
  service.state = "connected"
  await nextTick()
  expect(service.markRead).toHaveBeenCalledExactlyOnceWith("30", "5")
})

test("late history for a previous route or retained machine cannot mark it read", async () => {
  service.views["30"]!.loading = true
  const { sessionId, scope } = setup()
  sessionId.value = "31"
  await nextTick()
  service.views["30"]!.loading = false
  await nextTick()
  expect(service.markRead).toHaveBeenCalledExactlyOnceWith("31", "7")
  scope.stop()
  service.views["31"]!.snapshot!.session.lastCompletedSeq = "10"
  service.views["31"]!.historySeq = "10"
  await nextTick()
  expect(service.markRead).toHaveBeenCalledTimes(1)
})

test("history progress does not duplicate an in-flight acknowledgement", async () => {
  const response = deferred<void>()
  service.markRead.mockReturnValueOnce(response.promise)
  setup()
  service.views["30"]!.historySeq = "6"
  await nextTick()
  expect(service.markRead).toHaveBeenCalledTimes(1)
  response.reject(new Error("Connection lost"))
  await flushPromises()
  expect(service.markRead).toHaveBeenCalledTimes(1)
})
