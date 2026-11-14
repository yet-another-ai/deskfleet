import { createMemoryHistory, createRouter } from "vue-router"
import { expect, test } from "vitest"
import { navigationKey, resolveNavigationMotion, type NavigationMotion } from "./navigation-motion.ts"

const page = { render: () => null }
const router = createRouter({ history: createMemoryHistory(), routes: [
  { path: "/", name: "new-session", component: page },
  { path: "/search", name: "search", component: page },
  { path: "/schedules/:scheduleId?", name: "schedules", component: page },
  { path: "/sessions/:sessionId", name: "session", component: page },
  { path: "/machines/:machineId/control", name: "machine-control", component: page },
  { path: "/settings/appearance", name: "settings-appearance", component: page },
  { path: "/settings/developer", name: "settings-developer", component: page },
  { path: "/settings/developer/nat", name: "settings-developer-nat", component: page },
  { path: "/:pathMatch(.*)*", component: page },
] })

test.each<[string, string, NavigationMotion]>([
  ["/", "/search", "peer"],
  ["/settings/appearance", "/settings/developer", "peer"],
  ["/settings/developer", "/settings/developer/nat", "enter"],
  ["/settings/developer/nat", "/settings/developer", "return"],
  ["/schedules", "/schedules/new", "enter"],
  ["/schedules", "/schedules/task-1", "enter"],
  ["/schedules/new", "/schedules", "return"],
  ["/schedules/task-1", "/schedules", "return"],
  ["/schedules/new", "/schedules/task-1", "peer"],
  ["/schedules/task-1", "/schedules/task-2", "peer"],
  ["/sessions/a", "/sessions/b", "peer"],
  ["/machines/a/control", "/machines/b/control", "peer"],
  ["/search?q=first", "/search?q=second&kind=chat", "none"],
  ["/sessions/a?entry=first", "/sessions/a?entry=second", "none"],
  ["/machines/a/control?tab=terminal", "/machines/a/control?tab=desktop", "none"],
  ["/schedules/task-1", "/schedules/task-1#details", "none"],
  ["/unknown/one", "/unknown/two", "peer"],
])("%s → %s uses %s motion", (from, to, motion) => {
  expect(resolveNavigationMotion(router.resolve(to), router.resolve(from))).toBe(motion)
})

test("animation keys sort parameter names and retain array order without including query or hash", () => {
  const first = { ...router.resolve("/sessions/a?entry=first#message"), params: { machineId: "m1", sessionId: "a", directories: ["one", "two"] } }
  const reordered = { ...router.resolve("/sessions/a?entry=second#other"), params: { directories: ["one", "two"], sessionId: "a", machineId: "m1" } }
  expect(navigationKey(first)).toBe(navigationKey(reordered))
  expect(navigationKey({ ...first, params: { ...first.params, directories: ["two", "one"] } })).not.toBe(navigationKey(first))
})
