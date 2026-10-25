import assert from "node:assert/strict"
import test from "node:test"
import { DesktopPermissions } from "./desktop-permissions.ts"
import type { DesktopPermissionsState } from "./control-protocol.ts"

test("permission requests run once and a synchronous failure does not skip the other request", async () => {
  const permissions = new DesktopPermissions()
  const changes: DesktopPermissionsState[] = []
  const completed = new Promise<void>(resolve => permissions.onChange(state => {
    changes.push(state)
    if (state.screenCapturePermission.status !== "requesting" && state.accessibilityPermission.status !== "requesting") resolve()
  }))
  const requested: string[] = []
  const request = {
    requestScreenCaptureAccess: () => { requested.push("screen"); throw new Error("screen consent unavailable") },
    requestAccessibilityAccess: async () => { requested.push("accessibility"); return true },
  }
  permissions.request(request)
  permissions.request(request)
  await completed
  assert.deepEqual(requested, ["screen", "accessibility"])
  assert.deepEqual(permissions.state, {
    screenCapturePermission: { status: "error", error: "screen consent unavailable" },
    accessibilityPermission: { status: "granted" },
  })
  assert.equal(changes.length, 2)
  assert.deepEqual(changes[0]?.accessibilityPermission, { status: "requesting" })
  const snapshot = permissions.state
  snapshot.accessibilityPermission.status = "denied"
  assert.deepEqual(permissions.state.accessibilityPermission, { status: "granted" })
})
