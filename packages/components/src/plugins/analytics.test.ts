import { createApp } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { afterEach, expect, test, vi } from "vitest"
import { initializeAnalytics, shutdownAnalytics, trackEvent } from "../services/analytics.ts"
import { installAnalytics } from "./analytics.ts"
import { observePeerGrant } from "@deskfleet/client/peer-telemetry"

vi.mock("../services/analytics.ts", () => ({ analyticsTeamId: vi.fn(() => "team-1"), initializeAnalytics: vi.fn(), shutdownAnalytics: vi.fn(), trackEvent: vi.fn() }))
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs() })

test("tracks confirmed named routes without IDs, queries, or user text and stops on unmount", async () => {
  vi.stubEnv("VITE_STATSIG_CLIENT_KEY", "client-test")
  vi.stubEnv("VITE_STATSIG_ENVIRONMENT", "staging")
  const component = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", name: "new-session", component },
    { path: "/sessions/:id", name: "session", component },
    { path: "/blocked", name: "blocked", component, beforeEnter: () => false },
  ] })
  const app = createApp(component)
  installAnalytics(app, router)
  app.use(router).mount(document.createElement("div"))
  await router.isReady()
  await router.push("/sessions/private-id?text=private-text#private-hash")
  await router.push("/blocked")
  expect(initializeAnalytics).toHaveBeenCalledExactlyOnceWith({ clientKey: "client-test", environment: "staging", platform: "desktop" })
  expect(trackEvent).toHaveBeenCalledWith("page_viewed", { page: "new-session" })
  expect(trackEvent).toHaveBeenCalledWith("page_viewed", { page: "session" })
  expect(trackEvent).not.toHaveBeenCalledWith("page_viewed", { page: "blocked" })
  expect(JSON.stringify(vi.mocked(trackEvent).mock.calls)).not.toContain("private")
  app.unmount()
  const count = vi.mocked(trackEvent).mock.calls.length
  await router.push("/")
  expect(trackEvent).toHaveBeenCalledTimes(count)
  expect(shutdownAnalytics).toHaveBeenCalledTimes(1)
})

test("authentication pages use a fixed page name", () => {
  const app = createApp({ render: () => null })
  installAnalytics(app)
  app.mount(document.createElement("div"))
  expect(trackEvent).toHaveBeenCalledWith("page_viewed", { page: "authentication" })
  app.unmount()
})

test("peer events retain only metadata for the selected Team and stop at root teardown", () => {
  const app = createApp({ render: () => null })
  installAnalytics(app)
  app.mount(document.createElement("div"))
  observePeerGrant("files", { iceServers: [], relayDeniedReason: "free_plan" }, "team-1").failed()
  expect(trackEvent).toHaveBeenCalledWith("peer_granted", { feature: "files", relay: "free_plan" })
  expect(trackEvent).toHaveBeenCalledWith("peer_connection", { feature: "files", relay: "free_plan", outcome: "failed", transport: "unknown" })
  const count = vi.mocked(trackEvent).mock.calls.length
  observePeerGrant("ports", { iceServers: [] }, "another-team").connected()
  expect(trackEvent).toHaveBeenCalledTimes(count)
  app.unmount()
  observePeerGrant("files", { iceServers: [] }, "team-1").connected()
  expect(trackEvent).toHaveBeenCalledTimes(count)
})
