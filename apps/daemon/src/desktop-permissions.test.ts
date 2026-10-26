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
  // Each prompt publishes requesting, then its result. The initial silent state is checking.
  assert.equal(changes.length, 6)
  assert.deepEqual(changes[0]?.fullDiskAccessPermission, { status: "requesting" })
  assert.equal(changes[0]?.accessibilityPermission.status, "checking")
  const snapshot = permissions.state
  snapshot.accessibilityPermission.status = "denied"
  snapshot.fullDiskAccessPermission.status = "granted"
  assert.deepEqual(permissions.state.accessibilityPermission, { status: "granted" })
  assert.deepEqual(permissions.state.fullDiskAccessPermission, { status: "denied" })
})

test("guided initialization does not report requesting while a silent check is in progress", async () => {
  const permissions = new DesktopPermissions()
  const changes: DesktopPermissionsState[] = []
  permissions.onChange(state => changes.push(state))
  const pending = deferred<boolean>()
  permissions.initialize({
    fullDiskAccess: async () => true,
    screenCapture: async () => true,
    accessibility: async () => true,
  }, {
    fullDiskAccess: () => pending.promise,
    screenCapture: async () => false,
    accessibility: async () => null,
  }, "guided")
  assert.equal(permissions.state.fullDiskAccessPermission.status, "checking")
  assert.equal(permissions.state.screenCapturePermission.status, "checking")
  assert.equal(permissions.state.accessibilityPermission.status, "checking")
  assert.equal(changes.some(state => Object.values(state).some(permission => permission.status === "requesting")), false)
  pending.resolve(true)
  const state = await permissions.refresh()
  assert.equal(state.fullDiskAccessPermission.status, "granted")
  assert.equal(state.screenCapturePermission.status, "denied")
  assert.equal(state.accessibilityPermission.status, "not-required")
  assert.equal(changes.some(state => Object.values(state).some(permission => permission.status === "requesting")), false)
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

test("native changes wait for older checks and coalesce changes during the next check", async () => {
  const permissions = new DesktopPermissions()
  const initial = deferred<boolean>()
  const next = deferred<boolean>()
  const nextStarted = deferred<void>()
  let checks = 0
  const access = { fullDiskAccess: async () => null, screenCapture: async () => true, accessibility: async () => true }
  permissions.initialize(access, {
    ...access,
    accessibility: async () => {
      checks++
      if (checks === 1) return initial.promise
      if (checks === 2) { nextStarted.resolve(); return next.promise }
      return false
    },
  }, "guided")
  const refreshing = permissions.refreshAfterChange()
  void permissions.refreshAfterChange()
  initial.resolve(true)
  await nextStarted.promise
  void permissions.refreshAfterChange()
  void permissions.refreshAfterChange()
  next.resolve(true)
  await refreshing
  assert.equal(checks, 3)
  assert.equal(permissions.state.screenCapturePermission.status, "granted")
  assert.equal(permissions.state.accessibilityPermission.status, "denied")
})

test("an event-triggered check cannot overwrite a newer explicit request", async () => {
  const permissions = new DesktopPermissions()
  const checking = deferred<void>()
  const stale = deferred<boolean>()
  const granted = deferred<void>()
  let checkPending = false
  const access = { fullDiskAccess: async () => null, screenCapture: async () => true, accessibility: async () => true }
  permissions.initialize(access, {
    ...access,
    accessibility: async () => {
      if (!checkPending) return false
      checking.resolve()
      return stale.promise
    },
  }, "guided")
  await permissions.refresh()
  checkPending = true
  const refreshing = permissions.refreshAfterChange()
  await checking.promise
  permissions.onChange(state => { if (state.accessibilityPermission.status === "granted") granted.resolve() })
  permissions.requestPermission("accessibility")
  await granted.promise
  stale.resolve(false)
  await refreshing
  assert.equal(permissions.state.accessibilityPermission.status, "granted")
})
