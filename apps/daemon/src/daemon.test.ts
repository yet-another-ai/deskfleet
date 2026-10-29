import { TestAgentQuotas } from "./fixtures/agent-quotas.ts"
import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nativeInfo, openInMemoryCatalog } from "@deskfleet/native"
import { DaemonClient, readDaemonDiscovery, startDaemon as startNativeDaemon } from "./index.ts"
import type { DesktopPermission } from "./control-protocol.ts"

function startDaemon(port = 0, options: Parameters<typeof startNativeDaemon>[1] = {}) {
  return startNativeDaemon(port, { permissionPlatform: "darwin", ...options })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

test("headless daemon serves information from the Rust addon", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-daemon-test-"))
  const starting = startDaemon(0, { agentQuotas: new TestAgentQuotas(), allowLocalControlForTests: true, controlDirectory: directory,
    openCatalog: (_path, name) => openInMemoryCatalog(name),
    requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null,
  })
  context.after(async () => { await (await starting).close(); await rm(directory, { recursive: true, force: true }) })
  const daemon = await starting
  context.signal.throwIfAborted()

  const response = await fetch(`${daemon.address}/healthz`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: "ok", native: nativeInfo() })
  assert.ok(daemon.address.startsWith("http://127.0.0.1:"))
})

test("authenticated shutdown acknowledges before cleanup and releases discovery last", { timeout: 15_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-daemon-shutdown-"))
  const starting = startDaemon(0, { agentQuotas: new TestAgentQuotas(), allowLocalControlForTests: true, controlDirectory: directory, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
  let restarting: ReturnType<typeof startDaemon> | undefined
  let releaseCleanup!: () => void
  let cleanupStarted!: () => void
  const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve })
  const cleaning = new Promise<void>(resolve => { cleanupStarted = resolve })
  context.after(async () => {
    releaseCleanup()
    await (await starting).close()
    await (await restarting)?.close()
    await rm(directory, { recursive: true, force: true })
  })
  const daemon = await starting
  context.signal.throwIfAborted()
  const closeTerminals = daemon.terminals.close.bind(daemon.terminals)
  daemon.terminals.close = async () => {
    cleanupStarted()
    await cleanupGate
    await closeTerminals()
  }
  const client = await DaemonClient.connect(() => {}, () => {}, directory)
  context.after(() => client.close())
  await client.call("workspaceCreate", { name: "Persistent workspace", directories: [{ path: directory }] })
  await client.call("terminalDial", { mode: "create", terminalId: "shutdown-terminal", cols: 80, rows: 24, cwd: directory })
  const discovery = await readDaemonDiscovery(directory)

  assert.equal(await client.call("shutdown", {}), null)
  await cleaning
  assert.deepEqual(await readDaemonDiscovery(directory), discovery)
  await assert.rejects(DaemonClient.connect(() => {}, () => {}, directory))
  await assert.rejects(startDaemon(0, { agentQuotas: new TestAgentQuotas(), allowLocalControlForTests: true, controlDirectory: directory, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null }), /already running/)
  assert.deepEqual(await readDaemonDiscovery(directory), discovery)
  assert.equal(daemon.close(), daemon.closed)
  releaseCleanup()
  await daemon.closed
  await assert.rejects(readDaemonDiscovery(directory), { code: "ENOENT" })
  await assert.rejects(fetch(`${daemon.address}/healthz`))
  await assert.rejects(daemon.terminals.dial({ mode: "resume", terminalId: "shutdown-terminal" }), /closed/)
  assert.equal(daemon.close(), daemon.closed)

  context.signal.throwIfAborted()
  restarting = startDaemon(0, { agentQuotas: new TestAgentQuotas(), allowLocalControlForTests: true, controlDirectory: directory, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
  const restarted = await restarting
  context.signal.throwIfAborted()
  const next = await DaemonClient.connect(() => {}, () => {}, directory)
  context.after(() => next.close())
  assert.equal((await next.call("catalogList", {})).workspaces[0]?.name, "Persistent workspace")
  await restarted.close()
})

test("startup requests file and desktop permissions once without blocking health and catalog", { timeout: 15_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-daemon-permission-"))
  const screen = deferred<boolean | null>()
  const accessibility = deferred<boolean | null>()
  const files = deferred<boolean | null>()
  const requests = { screen: 0, accessibility: 0, files: 0 }
  const starting = startDaemon(0, { agentQuotas: new TestAgentQuotas(), allowLocalControlForTests: true,
    controlDirectory: directory,
    openCatalog: (_path, name) => openInMemoryCatalog(name),
    requestScreenCaptureAccess: () => { requests.screen++; return screen.promise },
    requestAccessibilityAccess: () => { requests.accessibility++; return accessibility.promise },
    requestFullDiskAccess: () => { requests.files++; return files.promise },
  })
  context.after(async () => {
    screen.resolve(null)
    accessibility.resolve(null)
    files.resolve(null)
    await (await starting).close()
    await rm(directory, { recursive: true, force: true })
  })
  const daemon = await starting
  context.signal.throwIfAborted()
  assert.deepEqual(requests, { screen: 1, accessibility: 1, files: 1 })
  const screenChanged = deferred<DesktopPermission>()
  const accessibilityChanged = deferred<DesktopPermission>()
  const filesChanged = deferred<DesktopPermission>()
  const client = await DaemonClient.connect(event => {
    if (event.kind !== "desktopPermissionsChanged") return
    if (event.permissions.screenCapturePermission.status !== "requesting") screenChanged.resolve(event.permissions.screenCapturePermission)
    if (event.permissions.accessibilityPermission.status !== "requesting") accessibilityChanged.resolve(event.permissions.accessibilityPermission)
    if (event.permissions.fullDiskAccessPermission.status !== "requesting") filesChanged.resolve(event.permissions.fullDiskAccessPermission)
  }, () => {}, directory)
  context.after(() => client.close())
  assert.deepEqual(client.info?.screenCapturePermission, { status: "requesting" })
  assert.deepEqual(client.info?.accessibilityPermission, { status: "requesting" })
  assert.deepEqual(client.info?.fullDiskAccessPermission, { status: "requesting" })
  assert.equal((await fetch(`${daemon.address}/healthz`)).status, 200)
  const workspace = await client.call("workspaceCreate", { name: "During permission request", directories: [{ path: directory }] })
  assert.equal((await client.call("catalogList", {})).workspaces[0]?.id, workspace.id)

  let competingRequests = 0
  await assert.rejects(startDaemon(0, { agentQuotas: new TestAgentQuotas(), allowLocalControlForTests: true,
    controlDirectory: directory,
    openCatalog: (_path, name) => openInMemoryCatalog(name),
    requestScreenCaptureAccess: async () => { competingRequests++; return null },
    requestAccessibilityAccess: async () => { competingRequests++; return null },
    requestFullDiskAccess: async () => { competingRequests++; return null },
  }), /already running/u)
  assert.equal(competingRequests, 0)
  assert.deepEqual(requests, { screen: 1, accessibility: 1, files: 1 })

  accessibility.resolve(true)
  assert.deepEqual(await accessibilityChanged.promise, { status: "granted" })
  const pendingObserver = await DaemonClient.connect(() => {}, () => {}, directory)
  context.after(() => pendingObserver.close())
  assert.deepEqual(pendingObserver.info?.screenCapturePermission, { status: "requesting" })
  assert.deepEqual(pendingObserver.info?.accessibilityPermission, { status: "granted" })
  assert.deepEqual(pendingObserver.info?.fullDiskAccessPermission, { status: "requesting" })
  files.resolve(true)
  assert.deepEqual(await filesChanged.promise, { status: "granted" })
  screen.resolve(true)
  assert.deepEqual(await screenChanged.promise, { status: "granted" })
  const observer = await DaemonClient.connect(() => {}, () => {}, directory)
  context.after(() => observer.close())
  assert.deepEqual(observer.info?.screenCapturePermission, { status: "granted" })
  assert.deepEqual(observer.info?.accessibilityPermission, { status: "granted" })
  assert.deepEqual(observer.info?.fullDiskAccessPermission, { status: "granted" })
  assert.deepEqual(requests, { screen: 1, accessibility: 1, files: 1 })
})

test("daemon shutdown does not wait for file or desktop permission responses", { timeout: 15_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-daemon-permission-shutdown-"))
  const screen = deferred<boolean | null>()
  const accessibility = deferred<boolean | null>()
  const files = deferred<boolean | null>()
  const starting = startDaemon(0, {
    agentQuotas: new TestAgentQuotas(), allowLocalControlForTests: true, controlDirectory: directory,
    openCatalog: (_path, name) => openInMemoryCatalog(name),
    requestScreenCaptureAccess: () => screen.promise,
    requestAccessibilityAccess: () => accessibility.promise,
    requestFullDiskAccess: () => files.promise,
  })
  context.after(async () => {
    screen.resolve(null)
    accessibility.resolve(null)
    files.resolve(null)
    await (await starting).close()
    await rm(directory, { recursive: true, force: true })
  })
  const daemon = await starting
  context.signal.throwIfAborted()
  const client = await DaemonClient.connect(() => {}, () => {}, directory)
  context.after(() => client.close())
  assert.deepEqual(client.info?.screenCapturePermission, { status: "requesting" })
  assert.deepEqual(client.info?.accessibilityPermission, { status: "requesting" })
  assert.deepEqual(client.info?.fullDiskAccessPermission, { status: "requesting" })
  await client.call("shutdown", {})
  await daemon.closed
  await assert.rejects(readDaemonDiscovery(directory), { code: "ENOENT" })
  // All requests are deliberately still pending when shutdown completes.
  screen.resolve(false)
  accessibility.resolve(false)
  files.resolve(false)
})

const permissionKeys = ["screenCapturePermission", "accessibilityPermission", "fullDiskAccessPermission"] as const

test("hosted Wayland startup authorizes screen and input once while IPC remains available", { timeout: 15_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-daemon-wayland-"))
  const consent = deferred<{ screenCapture: boolean; control: boolean }>()
  const requested: string[] = []
  let checks = 0
  let closes = 0
  let access = { screenCapture: true, control: true }
  const daemon = await startDaemon(0, {
    permissionPlatform: "linux", linuxDesktopBackend: "wayland", permissionMode: "guided", controlDirectory: directory,
    agentQuotas: new TestAgentQuotas(), allowLocalControlForTests: true, openCatalog: (_path, name) => openInMemoryCatalog(name),
    linuxDesktopAccess: {
      request: path => { requested.push(path); return consent.promise },
      check: async () => { checks++; return access },
      close: async () => { closes++ },
    },
  })
  context.after(async () => { consent.resolve({ screenCapture: false, control: false }); await daemon.close(); await rm(directory, { recursive: true, force: true }) })
  const granted = deferred<void>()
  const client = await DaemonClient.connect(event => {
    if (event.kind === "desktopPermissionsChanged" && event.permissions.screenCapturePermission.status === "granted"
      && event.permissions.accessibilityPermission.status === "granted") granted.resolve()
  }, () => {}, directory)
  context.after(() => client.close())
  assert.deepEqual(requested, [directory])
  assert.equal(client.info?.screenCapturePermission.status, "requesting")
  assert.equal(client.info?.accessibilityPermission.status, "requesting")
  assert.equal(client.info?.fullDiskAccessPermission.status, "not-required")
  await client.call("permissionRequest", { permission: "accessibility" })
  await client.call("permissionsRefresh", {})
  assert.deepEqual(requested, [directory])
  assert.equal(checks, 0)
  assert.deepEqual((await client.call("catalogList", {})).workspaces, [])
  assert.equal((await fetch(`${daemon.address}/healthz`)).status, 200)
  consent.resolve({ screenCapture: true, control: true })
  await granted.promise
  assert.equal((await client.call("permissionsRefresh", {})).screenCapturePermission.status, "granted")
  assert.equal(checks, 1)
  const observer = await DaemonClient.connect(() => {}, () => {}, directory)
  context.after(() => observer.close())
  assert.equal(observer.info?.accessibilityPermission.status, "granted")
  assert.equal(checks, 2)
  access = { screenCapture: false, control: false }
  const afterRevocation = await DaemonClient.connect(() => {}, () => {}, directory)
  context.after(() => afterRevocation.close())
  assert.equal(afterRevocation.info?.screenCapturePermission.status, "denied")
  assert.equal(afterRevocation.info?.accessibilityPermission.status, "denied")
  assert.equal(afterRevocation.info?.fullDiskAccessPermission.status, "not-required")
  assert.equal(checks, 3)
  assert.deepEqual(requested, [directory])
  await daemon.close()
  assert.equal(closes, 1)
})

for (const beforeConsentSettles of [false, true]) test(`connected clients learn when Wayland input ends ${beforeConsentSettles ? "before consent settles" : "after consent"} while capture remains`, { timeout: 15_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-daemon-wayland-input-"))
  const consent = deferred<{ screenCapture: boolean; control: boolean }>()
  const requested: string[] = []
  let checks = 0
  let notify = () => {}
  let access = { screenCapture: true, control: true }
  const daemon = await startDaemon(0, {
    permissionPlatform: "linux", linuxDesktopBackend: "wayland", controlDirectory: directory,
    agentQuotas: new TestAgentQuotas(), allowLocalControlForTests: true, openCatalog: (_path, name) => openInMemoryCatalog(name),
    linuxDesktopAccess: {
      request: path => { requested.push(path); return consent.promise },
      check: async () => { checks++; return access },
      close: async () => {},
      subscribe: listener => {
        notify = listener
        return () => { notify = () => {} }
      },
    },
  })
  context.after(async () => { consent.resolve({ screenCapture: false, control: false }); await daemon.close(); await rm(directory, { recursive: true, force: true }) })
  const granted = deferred<void>()
  const lost = deferred<void>()
  const client = await DaemonClient.connect(event => {
    if (event.kind !== "desktopPermissionsChanged") return
    const { screenCapturePermission, accessibilityPermission } = event.permissions
    if (screenCapturePermission.status === "granted" && accessibilityPermission.status === "granted") granted.resolve()
    if (screenCapturePermission.status === "granted" && accessibilityPermission.status === "denied") lost.resolve()
  }, () => {}, directory)
  context.after(() => client.close())
  consent.resolve({ screenCapture: true, control: true })
  if (!beforeConsentSettles) {
    await granted.promise
    assert.equal((await client.call("permissionsRefresh", {})).accessibilityPermission.status, "granted")
  }
  assert.deepEqual(requested, [directory])
  const checksAfterGrant = checks
  access = { screenCapture: true, control: false }
  notify()
  await lost.promise
  assert.equal(checks, checksAfterGrant + 1)
  assert.deepEqual(requested, [directory])
})

test("Wayland shutdown cancels the owning Portal request before awaiting peer cleanup", { timeout: 15_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-daemon-wayland-close-"))
  const consent = deferred<{ screenCapture: boolean; control: boolean }>()
  const requested = deferred<void>()
  const cleanup: string[] = []
  const daemon = await startDaemon(0, {
    permissionPlatform: "linux", linuxDesktopBackend: "wayland", controlDirectory: directory,
    openCatalog: (_path, name) => openInMemoryCatalog(name),
    linuxDesktopAccess: {
      request: () => { requested.resolve(); return consent.promise },
      check: async () => ({ screenCapture: false, control: false }),
      close: async () => { cleanup.push("portal"); consent.reject(new Error("Portal request cancelled")) },
    },
  })
  context.after(async () => { await daemon.close(); await rm(directory, { recursive: true, force: true }) })
  const closePeers = daemon.peers.closeAll.bind(daemon.peers)
  daemon.peers.closeAll = async () => { cleanup.push("peers"); await closePeers() }
  await requested.promise
  await daemon.close()
  assert.deepEqual(cleanup, ["portal", "peers"])
  await assert.rejects(readDaemonDiscovery(directory), { code: "ENOENT" })
})

test("guided daemon setup exposes checks and individual requests through authenticated local IPC", { timeout: 15_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-daemon-guided-"))
  const consent = deferred<boolean | null>()
  let granted = false
  const requests: string[] = []
  const daemon = await startDaemon(0, {
    controlDirectory: directory, permissionMode: "guided",
    openCatalog: (_path, name) => openInMemoryCatalog(name),
    checkFullDiskAccess: async () => granted,
    checkScreenCaptureAccess: async () => false,
    checkAccessibilityAccess: async () => null,
    requestFullDiskAccess: () => { requests.push("files"); return consent.promise },
    requestScreenCaptureAccess: async () => { requests.push("screen"); return true },
    requestAccessibilityAccess: async () => { requests.push("accessibility"); return true },
  })
  context.after(async () => { consent.resolve(null); await daemon.close(); await rm(directory, { recursive: true, force: true }) })
  const permissionChanged = deferred<DesktopPermission>()
  const client = await DaemonClient.connect(event => {
    if (event.kind === "desktopPermissionsChanged" && event.permissions.fullDiskAccessPermission.status === "granted") {
      permissionChanged.resolve(event.permissions.fullDiskAccessPermission)
    }
  }, () => {}, directory)
  context.after(() => client.close())
  assert.deepEqual(await client.call("permissionsRefresh", {}), {
    fullDiskAccessPermission: { status: "denied" },
    screenCapturePermission: { status: "denied" },
    accessibilityPermission: { status: "not-required" },
  })
  assert.deepEqual(requests, [])
  await assert.rejects(client.call("permissionRequest", { permission: "unknown" as never }), /Unknown system permission/u)
  assert.deepEqual(requests, [])
  assert.equal((await client.call("permissionRequest", { permission: "fullDiskAccess" })).fullDiskAccessPermission.status, "requesting")
  assert.deepEqual(requests, ["files"])
  assert.equal((await client.call("permissionsRefresh", {})).fullDiskAccessPermission.status, "requesting")
  assert.equal((await fetch(`${daemon.address}/healthz`)).status, 200)
  granted = true
  consent.resolve(true)
  assert.deepEqual(await permissionChanged.promise, { status: "granted" })
  assert.equal((await client.call("permissionsRefresh", {})).fullDiskAccessPermission.status, "granted")
  assert.deepEqual(requests, ["files"])
  await client.call("shutdown", {})
  await daemon.closed
})

for (const permissionKey of permissionKeys) {
  for (const outcome of [
    { name: "granted", value: true, expected: { status: "granted" } },
    { name: "denied", value: false, expected: { status: "denied" } },
    { name: "not required", value: null, expected: { status: "not-required" } },
    { name: "failed", error: "Permission service unavailable", expected: { status: "error", error: "Permission service unavailable" } },
  ] as const) {
    test(`a ${outcome.name} ${permissionKey} request leaves the daemon usable and reports its state`, { timeout: 15_000 }, async context => {
      const directory = await mkdtemp(join(tmpdir(), "df-daemon-permission-result-"))
      const permission = deferred<boolean | null>()
      const otherKeys = permissionKeys.filter(key => key !== permissionKey)
      const starting = startDaemon(0, {
        agentQuotas: new TestAgentQuotas(), allowLocalControlForTests: true, controlDirectory: directory,
        openCatalog: (_path, name) => openInMemoryCatalog(name),
        requestScreenCaptureAccess: permissionKey === "screenCapturePermission" ? () => permission.promise : async () => true,
        requestAccessibilityAccess: permissionKey === "accessibilityPermission" ? () => permission.promise : async () => true,
        requestFullDiskAccess: permissionKey === "fullDiskAccessPermission" ? () => permission.promise : async () => true,
      })
      context.after(async () => {
        permission.resolve(null)
        await (await starting).close()
        await rm(directory, { recursive: true, force: true })
      })
      const daemon = await starting
      context.signal.throwIfAborted()
      const changed = deferred<DesktopPermission>()
      const client = await DaemonClient.connect(event => {
        if (event.kind === "desktopPermissionsChanged" && event.permissions[permissionKey].status !== "requesting") changed.resolve(event.permissions[permissionKey])
      }, () => {}, directory)
      context.after(() => client.close())
      assert.deepEqual(client.info?.[permissionKey], { status: "requesting" })
      for (const key of otherKeys) assert.deepEqual(client.info?.[key], { status: "granted" })
      if ("error" in outcome) permission.reject(new Error(outcome.error))
      else permission.resolve(outcome.value)
      assert.deepEqual(await changed.promise, outcome.expected)
      assert.equal((await fetch(`${daemon.address}/healthz`)).status, 200)
      assert.deepEqual((await client.call("catalogList", {})).workspaces, [])
      const observer = await DaemonClient.connect(() => {}, () => {}, directory)
      context.after(() => observer.close())
      assert.deepEqual(observer.info?.[permissionKey], outcome.expected)
      for (const key of otherKeys) assert.deepEqual(observer.info?.[key], { status: "granted" })
    })
  }
}


test("X11 daemon publishes its backend and probes access without Portal consent", { timeout: 15_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-daemon-x11-"))
  let requested = 0
  let watched = 0
  let access = { screenCapture: true, control: true }
  const daemon = await startDaemon(0, {
    permissionPlatform: "linux", linuxDesktopBackend: "x11", controlDirectory: directory,
    openCatalog: (_path, name) => openInMemoryCatalog(name),
    linuxDesktopAccess: {
      request: async () => { requested++; return access }, check: async () => access, close: async () => {},
      subscribe: () => { watched++; return () => {} },
    },
  })
  context.after(async () => { await daemon.close(); await rm(directory, { recursive: true, force: true }) })
  const client = await DaemonClient.connect(() => {}, () => {}, directory)
  context.after(() => client.close())
  assert.equal(client.info?.linuxDesktopBackend, "x11")
  assert.equal(client.info?.screenCapturePermission.status, "not-required")
  assert.equal(client.info?.accessibilityPermission.status, "not-required")
  access = { screenCapture: true, control: false }
  assert.equal((await client.call("permissionsRefresh", {})).accessibilityPermission.status, "denied")
  assert.equal(requested, 0)
  assert.equal(watched, 0)
})
