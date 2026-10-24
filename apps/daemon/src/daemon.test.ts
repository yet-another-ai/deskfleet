import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nativeInfo } from "@deskfleet/native"
import { DaemonClient, readDaemonDiscovery, startDaemon } from "./index.ts"
import type { ScreenCapturePermission } from "./control-protocol.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

test("headless daemon serves information from the Rust addon", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-daemon-test-"))
  const starting = startDaemon(0, { allowLocalControlForTests: true, controlDirectory: directory, requestScreenCaptureAccess: async () => null })
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
  const starting = startDaemon(0, { allowLocalControlForTests: true, controlDirectory: directory, requestScreenCaptureAccess: async () => null })
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
  await assert.rejects(startDaemon(0, { allowLocalControlForTests: true, controlDirectory: directory, requestScreenCaptureAccess: async () => null }), /already running/)
  assert.deepEqual(await readDaemonDiscovery(directory), discovery)
  assert.equal(daemon.close(), daemon.closed)
  releaseCleanup()
  await daemon.closed
  await assert.rejects(readDaemonDiscovery(directory), { code: "ENOENT" })
  await assert.rejects(fetch(`${daemon.address}/healthz`))
  await assert.rejects(daemon.terminals.dial({ mode: "resume", terminalId: "shutdown-terminal" }), /closed/)
  assert.equal(daemon.close(), daemon.closed)

  context.signal.throwIfAborted()
  restarting = startDaemon(0, { allowLocalControlForTests: true, controlDirectory: directory, requestScreenCaptureAccess: async () => null })
  const restarted = await restarting
  context.signal.throwIfAborted()
  const next = await DaemonClient.connect(() => {}, () => {}, directory)
  context.after(() => next.close())
  assert.equal((await next.call("catalogList", {})).workspaces[0]?.name, "Persistent workspace")
  await restarted.close()
})

test("startup requests screen access once while health and catalog stay available, and publishes the result", { timeout: 15_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-daemon-permission-"))
  const permission = deferred<boolean | null>()
  let requests = 0
  const starting = startDaemon(0, { allowLocalControlForTests: true,
    controlDirectory: directory,
    requestScreenCaptureAccess: () => { requests++; return permission.promise },
  })
  context.after(async () => {
    permission.resolve(null)
    await (await starting).close()
    await rm(directory, { recursive: true, force: true })
  })
  const daemon = await starting
  context.signal.throwIfAborted()
  assert.equal(requests, 1)
  const changed = deferred<ScreenCapturePermission>()
  const client = await DaemonClient.connect(event => {
    if (event.kind === "screenCapturePermissionChanged") changed.resolve(event.permission)
  }, () => {}, directory)
  context.after(() => client.close())
  assert.deepEqual(client.info?.screenCapturePermission, { status: "requesting" })
  assert.equal((await fetch(`${daemon.address}/healthz`)).status, 200)
  const workspace = await client.call("workspaceCreate", { name: "During permission request", directories: [{ path: directory }] })
  assert.equal((await client.call("catalogList", {})).workspaces[0]?.id, workspace.id)

  let competingRequests = 0
  await assert.rejects(startDaemon(0, { allowLocalControlForTests: true,
    controlDirectory: directory,
    requestScreenCaptureAccess: async () => { competingRequests++; return null },
  }), /already running/u)
  assert.equal(competingRequests, 0)
  assert.equal(requests, 1)

  permission.resolve(true)
  assert.deepEqual(await changed.promise, { status: "granted" })
  const observer = await DaemonClient.connect(() => {}, () => {}, directory)
  context.after(() => observer.close())
  assert.deepEqual(observer.info?.screenCapturePermission, { status: "granted" })
  assert.equal(requests, 1)
})

test("daemon shutdown does not wait for a screen permission response", { timeout: 15_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-daemon-permission-shutdown-"))
  const permission = deferred<boolean | null>()
  const starting = startDaemon(0, { allowLocalControlForTests: true, controlDirectory: directory, requestScreenCaptureAccess: () => permission.promise })
  context.after(async () => {
    permission.resolve(null)
    await (await starting).close()
    await rm(directory, { recursive: true, force: true })
  })
  const daemon = await starting
  context.signal.throwIfAborted()
  const client = await DaemonClient.connect(() => {}, () => {}, directory)
  context.after(() => client.close())
  assert.deepEqual(client.info?.screenCapturePermission, { status: "requesting" })
  await client.call("shutdown", {})
  await daemon.closed
  await assert.rejects(readDaemonDiscovery(directory), { code: "ENOENT" })
  // The request is deliberately still pending when shutdown completes.
  permission.resolve(false)
})

for (const outcome of [
  { name: "denied", value: false, expected: { status: "denied" } },
  { name: "not required", value: null, expected: { status: "not-required" } },
  { name: "failed", error: "Permission service unavailable", expected: { status: "error", error: "Permission service unavailable" } },
] as const) {
  test(`a ${outcome.name} screen permission request leaves the daemon usable and reports its state`, { timeout: 15_000 }, async context => {
    const directory = await mkdtemp(join(tmpdir(), "df-daemon-permission-result-"))
    const permission = deferred<boolean | null>()
    const starting = startDaemon(0, { allowLocalControlForTests: true, controlDirectory: directory, requestScreenCaptureAccess: () => permission.promise })
    context.after(async () => {
      permission.resolve(null)
      await (await starting).close()
      await rm(directory, { recursive: true, force: true })
    })
    const daemon = await starting
    context.signal.throwIfAborted()
    const changed = deferred<ScreenCapturePermission>()
    const client = await DaemonClient.connect(event => {
      if (event.kind === "screenCapturePermissionChanged") changed.resolve(event.permission)
    }, () => {}, directory)
    context.after(() => client.close())
    assert.deepEqual(client.info?.screenCapturePermission, { status: "requesting" })
    if ("error" in outcome) permission.reject(new Error(outcome.error))
    else permission.resolve(outcome.value)
    assert.deepEqual(await changed.promise, outcome.expected)
    assert.equal((await fetch(`${daemon.address}/healthz`)).status, 200)
    assert.deepEqual((await client.call("catalogList", {})).workspaces, [])
    const observer = await DaemonClient.connect(() => {}, () => {}, directory)
    context.after(() => observer.close())
    assert.deepEqual(observer.info?.screenCapturePermission, outcome.expected)
  })
}
