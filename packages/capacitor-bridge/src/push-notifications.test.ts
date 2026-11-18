import { expect, test } from "vitest"
import { mapCapacitorPushPermission, parseNotificationTarget } from "./push-notifications.ts"

test("maps Capacitor permission states and parses notification tap targets", () => {
  expect(mapCapacitorPushPermission("prompt")).toBe("default")
  expect(mapCapacitorPushPermission("prompt-with-rationale")).toBe("default")
  expect(mapCapacitorPushPermission("granted")).toBe("granted")
  expect(mapCapacitorPushPermission("denied")).toBe("denied")

  expect(parseNotificationTarget({ teamId: "team-1", machineId: "mach-1", sessionId: "sess-1" })).toEqual({
    teamId: "team-1",
    machineId: "mach-1",
    sessionId: "sess-1",
  })
  expect(parseNotificationTarget({ teamId: "team-1", machineId: "mach-1" })).toBeUndefined()
  expect(parseNotificationTarget(null)).toBeUndefined()
})
