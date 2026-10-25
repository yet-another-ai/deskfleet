import assert from "node:assert/strict"
import test from "node:test"
import { DesktopPermissions } from "./desktop-permissions.ts"
import type { DesktopPermissionsState } from "./control-protocol.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test("permission requests run once and a synchronous failure does not skip other requests", async () => {
  const permissions = new DesktopPermissions()
  const changes: DesktopPermissionsState[] = []
  const completed = new Promise<void>(resolve => permissions.onChange(state => {
    changes.push(state)
    if (Object.values(state).every(permission => permission.status !== "requesting")) resolve()
  }))
  const requested: string[] = []
  const request = {
    screenCapture: () => { requested.push("screen"); throw new Error("screen consent unavailable") },
    accessibility: async () => { requested.push("accessibility"); return true },
    fullDiskAccess: async () => { requested.push("files"); return false },
  }
  permissions.initialize(request, request)
  permissions.initialize(request, request)
  await completed
  assert.deepEqual(requested, ["files", "screen", "accessibility"])
  assert.deepEqual(permissions.state, {
    screenCapturePermission: { status: "error", error: "screen consent unavailable" },
    accessibilityPermission: { status: "granted" },
    fullDiskAccessPermission: { status: "denied" },
  })
  assert.equal(changes.length, 3)
  assert.deepEqual(changes[0]?.accessibilityPermission, { status: "requesting" })
  const snapshot = permissions.state
  snapshot.accessibilityPermission.status = "denied"
  snapshot.fullDiskAccessPermission.status = "granted"
  assert.deepEqual(permissions.state.accessibilityPermission, { status: "granted" })
  assert.deepEqual(permissions.state.fullDiskAccessPermission, { status: "denied" })
})

test("guided initialization checks silently and coalesces pending requests without blocking refresh", async () => {
  const permissions = new DesktopPermissions()
  const consent = deferred<boolean | null>()
  const requested: string[] = []
  let filesGranted = false
  const checks = { fullDiskAccess: async () => filesGranted, screenCapture: async () => false, accessibility: async () => null }
  permissions.initialize({
    fullDiskAccess: async () => { requested.push("files"); return false },
    screenCapture: () => { requested.push("screen"); return consent.promise },
    accessibility: async () => { requested.push("accessibility"); return true },
  }, checks, "guided")
  assert.deepEqual(await permissions.refresh(), {
    fullDiskAccessPermission: { status: "denied" },
    screenCapturePermission: { status: "denied" },
    accessibilityPermission: { status: "not-required" },
  })
  assert.deepEqual(requested, [])
  assert.equal(permissions.requestPermission("screenCapture").screenCapturePermission.status, "requesting")
  permissions.requestPermission("screenCapture")
  filesGranted = true
  const state = await permissions.refresh()
  assert.deepEqual(requested, ["screen"])
  assert.equal(state.fullDiskAccessPermission.status, "granted")
  assert.equal(state.screenCapturePermission.status, "requesting")
  const settled = deferred<void>()
  permissions.onChange(state => { if (state.screenCapturePermission.status === "granted") settled.resolve() })
  consent.resolve(true)
  await settled.promise
})

test("a stale permission check cannot overwrite a request completed after that check started", async () => {
  const permissions = new DesktopPermissions()
  const stale = deferred<boolean | null>()
  const granted = deferred<void>()
  permissions.onChange(state => { if (state.fullDiskAccessPermission.status === "granted") granted.resolve() })
  const access = { fullDiskAccess: async () => true, screenCapture: async () => null, accessibility: async () => null }
  permissions.initialize(access, { ...access, fullDiskAccess: () => stale.promise }, "guided")
  const refreshing = permissions.refresh()
  permissions.requestPermission("fullDiskAccess")
  await granted.promise
  stale.resolve(false)
  assert.equal((await refreshing).fullDiskAccessPermission.status, "granted")
})
