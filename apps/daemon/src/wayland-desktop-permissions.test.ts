import assert from "node:assert/strict"
import test from "node:test"
import { DesktopPermissions } from "./desktop-permissions.ts"
import { WaylandDesktopPermissions, type WaylandDesktopAccess } from "./wayland-desktop-permissions.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

test("screen and control share one Portal request and refresh never requests consent", async () => {
  const access = deferred<WaylandDesktopAccess>()
  const requested: string[] = []
  let checks = 0
  const native = new WaylandDesktopPermissions("/daemon", {
    request: directory => { requested.push(directory); return access.promise },
    check: async () => { checks++; return { screenCapture: true, control: false } },
    close: async () => {},
  })
  const permissions = new DesktopPermissions()
  const completed = deferred<void>()
  permissions.onChange(state => {
    if (state.screenCapturePermission.status === "granted" && state.accessibilityPermission.status === "denied") completed.resolve()
  })
  permissions.initialize(native.requests, native.checks, "automatic", { linked: [["screenCapture", "accessibility"]] })
  await permissions.refresh()
  assert.deepEqual(requested, ["/daemon"])
  assert.equal(checks, 0)
  assert.equal(permissions.state.screenCapturePermission.status, "requesting")
  assert.equal(permissions.state.accessibilityPermission.status, "requesting")
  assert.equal(permissions.state.fullDiskAccessPermission.status, "not-required")
  access.resolve({ screenCapture: true, control: false })
  await completed.promise
  const state = await permissions.refresh()
  assert.equal(checks, 1)
  assert.deepEqual(requested, ["/daemon"])
  assert.equal(state.screenCapturePermission.status, "granted")
  assert.equal(state.accessibilityPermission.status, "denied")
})

test("requesting either linked permission refreshes both from the same Portal response", async () => {
  let requests = 0
  const native = new WaylandDesktopPermissions("/daemon", {
    request: async () => { requests++; return { screenCapture: true, control: true } },
    check: async () => ({ screenCapture: false, control: false }),
    close: async () => {},
  })
  const permissions = new DesktopPermissions()
  permissions.initialize(native.requests, native.checks, "guided", { linked: [["screenCapture", "accessibility"]] })
  await permissions.refresh()
  const completed = deferred<void>()
  permissions.onChange(state => {
    if (state.screenCapturePermission.status === "granted" && state.accessibilityPermission.status === "granted") completed.resolve()
  })
  const pending = permissions.requestPermission("accessibility")
  assert.equal(pending.screenCapturePermission.status, "requesting")
  assert.equal(pending.accessibilityPermission.status, "requesting")
  permissions.requestPermission("screenCapture")
  await completed.promise
  assert.equal(requests, 1)
})

test("closing cancels a pending Portal dialog and prevents another request", async () => {
  const access = deferred<WaylandDesktopAccess>()
  const started = deferred<void>()
  let requests = 0
  let closes = 0
  const native = new WaylandDesktopPermissions("/daemon", {
    request: () => { requests++; started.resolve(); return access.promise },
    check: async () => ({ screenCapture: true, control: true }),
    close: async () => { closes++; access.reject(new Error("Portal request cancelled")) },
  })
  const pending = assert.rejects(native.requests.screenCapture(), /cancelled/u)
  await started.promise
  await native.close()
  await native.close()
  await pending
  await assert.rejects(native.requests.accessibility(), /closing/u)
  assert.equal(await native.checks.screenCapture(), false)
  assert.equal(requests, 1)
  assert.equal(closes, 1)
})

test("access changes refresh permissions until the portal closes", async () => {
  let notify = () => {}
  let updates = 0
  let access = { screenCapture: true, control: true }
  const native = new WaylandDesktopPermissions("/daemon", {
    request: async () => access,
    check: async () => access,
    close: async () => {},
    subscribe: listener => {
      notify = listener
      return () => { notify = () => {} }
    },
  })
  const permissions = new DesktopPermissions()
  const changed = deferred<void>()
  permissions.onChange(state => {
    if (state.screenCapturePermission.status === "granted" && state.accessibilityPermission.status === "denied") changed.resolve()
  })
  permissions.initialize(native.requests, native.checks, "guided", {
    linked: [["screenCapture", "accessibility"]],
  })
  native.onAccessChanged(() => { updates++; void permissions.refreshAfterChange() })
  assert.equal((await permissions.refresh()).accessibilityPermission.status, "granted")
  access = { screenCapture: true, control: false }
  notify()
  await changed.promise
  assert.equal(permissions.state.screenCapturePermission.status, "granted")
  assert.equal(permissions.state.accessibilityPermission.status, "denied")
  const published = updates
  await native.close()
  access = { screenCapture: false, control: false }
  notify()
  await Promise.resolve()
  assert.equal(updates, published)
  assert.equal(permissions.state.screenCapturePermission.status, "granted")
})

test("closing during a queued access refresh cancels consent without checking or requesting again", async () => {
  const consent = deferred<WaylandDesktopAccess>()
  const started = deferred<void>()
  let requests = 0
  let checks = 0
  const native = new WaylandDesktopPermissions("/daemon", {
    request: () => { requests++; started.resolve(); return consent.promise },
    check: async () => { checks++; return { screenCapture: true, control: true } },
    close: async () => { consent.reject(new Error("Portal request cancelled")) },
  })
  const permissions = new DesktopPermissions()
  permissions.initialize(native.requests, native.checks, "automatic", {
    linked: [["screenCapture", "accessibility"]], refreshOnRead: true,
  })
  await started.promise
  const refreshing = permissions.refreshAfterChange()
  assert.equal((await permissions.readState()).accessibilityPermission.status, "requesting")
  await native.close()
  await refreshing
  assert.equal(requests, 1)
  assert.equal(checks, 0)
  assert.equal(permissions.state.screenCapturePermission.status, "denied")
  assert.equal(permissions.state.accessibilityPermission.status, "denied")
})

test("closing before the request microtask runs cannot reopen the Portal", async () => {
  let requests = 0
  const native = new WaylandDesktopPermissions("/daemon", {
    request: async () => { requests++; return { screenCapture: true, control: true } },
    check: async () => ({ screenCapture: false, control: false }),
    close: async () => {},
  })
  const pending = assert.rejects(native.requests.screenCapture(), /closing/u)
  await native.close()
  await pending
  assert.equal(requests, 0)
})
