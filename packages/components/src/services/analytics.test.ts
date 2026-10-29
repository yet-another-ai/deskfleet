import { flushPromises } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { analyticsReady, beginAnalyticsPlanRefresh, captureAnalyticsContext, identifyAnalytics, initializeAnalytics, shutdownAnalytics, trackEvent, useExperimentParameter, useFeatureGate } from "./analytics.ts"

const mock = vi.hoisted(() => {
  const sdk = {
    loadingStatus: "Loading",
    on: vi.fn(),
    initializeAsync: vi.fn(),
    updateUserAsync: vi.fn(),
    logEvent: vi.fn(),
    checkGate: vi.fn(() => true),
    getExperiment: vi.fn(() => ({ get: (_key: string, _fallback: unknown) => "variant" })),
    shutdown: vi.fn(async () => {}),
  }
  return { sdk, create: vi.fn(function (..._args: unknown[]) { return sdk }) }
})
vi.mock("@statsig/js-client", () => ({ StatsigClient: mock.create }))

function valuesUpdated(status = "Ready"): void {
  mock.sdk.loadingStatus = status
  mock.sdk.on.mock.calls.find(([name]) => name === "values_updated")?.[1]()
}
beforeEach(() => {
  vi.clearAllMocks()
  mock.sdk.loadingStatus = "Loading"
  mock.sdk.initializeAsync.mockImplementation(async () => { await Promise.resolve(); valuesUpdated() })
  mock.sdk.updateUserAsync.mockImplementation(async () => { valuesUpdated("Loading"); await Promise.resolve(); valuesUpdated() })
})
afterEach(shutdownAnalytics)

test("an absent key creates no SDK and leaves feature defaults usable", () => {
  initializeAnalytics({ platform: "web", environment: "test", clientKey: " " })
  trackEvent("workspace_created", { directory_count: 2 })
  expect(mock.create).not.toHaveBeenCalled()
  expect(mock.sdk.logEvent).not.toHaveBeenCalled()
  expect(analyticsReady.value).toBe(false)
  expect(useFeatureGate("test_gate").value).toBe(false)
  expect(useExperimentParameter("test_experiment", "label", "default").value).toBe("default")
})

test("one document owns one client with explicit privacy and network options", async () => {
  initializeAnalytics({ platform: "desktop", environment: "staging", clientKey: " client-test " })
  initializeAnalytics({ platform: "desktop", environment: "staging", clientKey: "client-test" })
  expect(mock.create).toHaveBeenCalledExactlyOnceWith("client-test", { custom: { platform: "desktop" } }, {
    environment: { tier: "staging" }, includeCurrentPageUrlWithEvents: false,
    networkConfig: {
      initializeUrl: "https://featureassets.org/v1/initialize", logEventUrl: "https://prodregistryv2.org/v1/rgstr",
      initializeFallbackUrls: [], logEventFallbackUrls: [],
    },
  })
  expect(analyticsReady.value).toBe(false)
  await flushPromises()
  expect(analyticsReady.value).toBe(true)
  trackEvent("workspace_created", { directory_count: 2 })
  expect(mock.sdk.logEvent).toHaveBeenCalledExactlyOnceWith("workspace_created", undefined, { directory_count: "2" })
})

test("feature reads react to initialization and identity changes without eager exposures", async () => {
  initializeAnalytics({ platform: "web", environment: "test", clientKey: "client-test" })
  const gate = useFeatureGate("new_ui")
  const variant = useExperimentParameter("composer", "layout", "default")
  expect(gate.value).toBe(false)
  expect(variant.value).toBe("default")
  expect(mock.sdk.checkGate).not.toHaveBeenCalled()
  expect(mock.sdk.getExperiment).not.toHaveBeenCalled()
  await flushPromises()
  expect(mock.sdk.checkGate).not.toHaveBeenCalled()
  expect(gate.value).toBe(true)
  expect(variant.value).toBe("variant")
  identifyAnalytics("user-a")
  expect(gate.value).toBe(false)
  expect(variant.value).toBe("default")
  expect(mock.sdk.updateUserAsync).toHaveBeenLastCalledWith({ userID: "user-a", custom: { platform: "web" } }, { timeoutMs: 1000 })
  await flushPromises()
  expect(gate.value).toBe(true)
  identifyAnalytics("user-a")
  expect(mock.sdk.updateUserAsync).toHaveBeenCalledTimes(1)
  identifyAnalytics()
  expect(mock.sdk.updateUserAsync).toHaveBeenLastCalledWith({ custom: { platform: "web" } }, { timeoutMs: 1000 })
  expect(gate.value).toBe(false)
})

test("initialization rejection does not block product events or feature defaults", async () => {
  mock.sdk.initializeAsync.mockRejectedValueOnce(new Error("Network unavailable"))
  initializeAnalytics({ platform: "web", environment: "test", clientKey: "client-test" })
  trackEvent("app_opened", {})
  await flushPromises()
  expect(analyticsReady.value).toBe(false)
  expect(useFeatureGate("new_ui").value).toBe(false)
  expect(mock.sdk.logEvent).toHaveBeenCalledWith("app_opened", undefined, {})
})

test("root teardown shuts down the client and clears identity and evaluations", async () => {
  initializeAnalytics({ platform: "web", environment: "test", clientKey: "client-test" })
  identifyAnalytics("user-a")
  await flushPromises()
  const gate = useFeatureGate("new_ui")
  expect(gate.value).toBe(true)
  await shutdownAnalytics()
  expect(mock.sdk.shutdown).toHaveBeenCalledTimes(1)
  expect(gate.value).toBe(false)
  initializeAnalytics({ platform: "web", environment: "test", clientKey: "client-test" })
  expect(mock.create.mock.calls.at(-1)?.[1]).toEqual({ custom: { platform: "web" } })
})

test("functional events carry selected Team/plan context without retaining it across account changes", async () => {
  initializeAnalytics({ platform: "web", environment: "test", clientKey: "client-test" })
  identifyAnalytics("user-a", { id: "team-a", role: "admin" })
  beginAnalyticsPlanRefresh("team-a")("go")
  await flushPromises()
  expect(mock.sdk.updateUserAsync).toHaveBeenLastCalledWith({ userID: "user-a", customIDs: { teamID: "team-a" }, custom: { platform: "web" } }, { timeoutMs: 1000 })
  trackEvent("input_submit_action", { outcome: "success", delivery: "backlog" })
  expect(mock.sdk.logEvent).toHaveBeenLastCalledWith("input_submit_action", undefined, {
    team_id: "team-a", team_role: "admin", current_plan: "go", outcome: "success", delivery: "backlog",
  })
  identifyAnalytics("user-a", { id: "team-b", role: "member" })
  beginAnalyticsPlanRefresh("team-a")("pro")
  trackEvent("session_archived", {})
  expect(mock.sdk.logEvent).toHaveBeenLastCalledWith("session_archived", undefined, { team_id: "team-b", team_role: "member", current_plan: "unknown" })
  trackEvent("team_join_action", { outcome: "attempt" })
  expect(mock.sdk.logEvent).toHaveBeenLastCalledWith("team_join_action", undefined, { outcome: "attempt" })
  identifyAnalytics()
  trackEvent("app_opened", {})
  expect(mock.sdk.logEvent).toHaveBeenLastCalledWith("app_opened", undefined, {})
})

test("a late same-Team billing response cannot replace newer plan context", () => {
  initializeAnalytics({ platform: "web", environment: "test", clientKey: "client-test" })
  identifyAnalytics("user-a", { id: "team-a", role: "admin" })
  const older = beginAnalyticsPlanRefresh("team-a")
  beginAnalyticsPlanRefresh("team-a")("pro")
  older("free")
  trackEvent("session_restored", {})
  expect(mock.sdk.logEvent).toHaveBeenLastCalledWith("session_restored", undefined, { team_id: "team-a", team_role: "admin", current_plan: "pro" })
})

test("pending action results are omitted after the account or selected Team changes", () => {
  initializeAnalytics({ platform: "web", environment: "test", clientKey: "client-test" })
  identifyAnalytics("user-a", { id: "team-a", role: "admin" })
  const first = captureAnalyticsContext()
  first("input_submit_action", { outcome: "attempt", delivery: "backlog" })
  first("input_submit_action", { outcome: "success", delivery: "backlog" })
  expect(mock.sdk.logEvent).toHaveBeenCalledTimes(2)
  identifyAnalytics("user-a", { id: "team-b", role: "admin" })
  first("input_submit_action", { outcome: "failure", delivery: "backlog" })
  expect(mock.sdk.logEvent).toHaveBeenCalledTimes(2)
  const second = captureAnalyticsContext()
  identifyAnalytics("user-b", { id: "team-b", role: "admin" })
  second("member_invite_action", { outcome: "success", invited_role: "member" })
  expect(mock.sdk.logEvent).toHaveBeenCalledTimes(2)
})
