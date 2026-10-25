import { afterEach, expect, test, vi } from "vitest"
import type { DaemonEvent } from "../../../daemon/src/control-protocol.ts"
import type { DesktopPermissionsState } from "../../../../packages/client/src/local-agent.ts"
import { createLocalAgentRuntime } from "./local-agent-runtime.ts"

const mocks = vi.hoisted(() => ({ connect: vi.fn(), startDaemon: vi.fn() }))
vi.mock("@deskfleet/daemon/control-client", () => ({ DaemonClient: { connect: mocks.connect } }))
vi.mock("@deskfleet/daemon", () => ({ startDaemon: mocks.startDaemon }))
afterEach(() => vi.clearAllMocks())

test("connection retains permission outcomes received alongside its initial handshake", async () => {
  let event!: (event: DaemonEvent) => void
  const client = {
    closed: false,
    info: { name: "machine", desktop: true, fullDiskAccessPermission: { status: "requesting" }, screenCapturePermission: { status: "requesting" }, accessibilityPermission: { status: "requesting" } },
    call: vi.fn(),
    close: vi.fn(),
  }
  mocks.connect.mockImplementation(async onEvent => {
    event = onEvent
    event({ kind: "desktopPermissionsChanged", permissions: { fullDiskAccessPermission: { status: "denied" }, screenCapturePermission: { status: "granted" }, accessibilityPermission: { status: "requesting" } } })
    return client
  })
  const changed = vi.fn()
  const runtime = createLocalAgentRuntime({ directory: "/daemon", start: vi.fn() })
  const connection = await runtime.connect(vi.fn(), changed)
  expect(connection.desktopPermissions).toEqual({ fullDiskAccessPermission: { status: "denied" }, screenCapturePermission: { status: "granted" }, accessibilityPermission: { status: "requesting" } })
  expect(changed).toHaveBeenCalledExactlyOnceWith(connection.desktopPermissions)
  event({ kind: "catalogChanged" })
  expect(changed).toHaveBeenCalledTimes(1)
  event({ kind: "desktopPermissionsChanged", permissions: { fullDiskAccessPermission: { status: "granted" }, screenCapturePermission: { status: "granted" }, accessibilityPermission: { status: "denied" } } })
  expect(changed).toHaveBeenLastCalledWith({ fullDiskAccessPermission: { status: "granted" }, screenCapturePermission: { status: "granted" }, accessibilityPermission: { status: "denied" } })
  expect(connection.desktopPermissions).toEqual({ fullDiskAccessPermission: { status: "granted" }, screenCapturePermission: { status: "granted" }, accessibilityPermission: { status: "denied" } })
})

test("connecting to an existing daemon reads permissions without starting another request", async () => {
  const client = {
    closed: false,
    info: { name: "machine", desktop: true, fullDiskAccessPermission: { status: "denied" }, screenCapturePermission: { status: "denied" }, accessibilityPermission: { status: "granted" } },
    call: vi.fn(),
    close: vi.fn(),
  }
  mocks.connect.mockResolvedValue(client)
  const runtime = createLocalAgentRuntime({ directory: "/daemon", start: vi.fn() })
  const connection = await runtime.connect(vi.fn(), vi.fn())
  expect(connection.desktopPermissions).toEqual({ fullDiskAccessPermission: { status: "denied" }, screenCapturePermission: { status: "denied" }, accessibilityPermission: { status: "granted" } })
  expect(client.call).not.toHaveBeenCalled()
})

test("permission actions use the authenticated daemon connection", async () => {
  const permissions = { fullDiskAccessPermission: { status: "granted" }, screenCapturePermission: { status: "denied" }, accessibilityPermission: { status: "granted" } }
  const client = { closed: false, info: permissions, call: vi.fn(async () => permissions), close: vi.fn() }
  mocks.connect.mockResolvedValue(client)
  const runtime = createLocalAgentRuntime({ directory: "/daemon" })
  const connection = await runtime.connect(vi.fn(), vi.fn())
  expect(await connection.refreshPermissions()).toEqual(permissions)
  expect(client.call).toHaveBeenLastCalledWith("permissionsRefresh", {})
  expect(await connection.requestPermission("fullDiskAccess")).toEqual(permissions)
  expect(client.call).toHaveBeenLastCalledWith("permissionRequest", { permission: "fullDiskAccess" })
  expect(connection.desktopPermissions).toEqual(permissions)
})

test.each(["refresh", "request"])("%s responses retain permission events that arrive before the response", async action => {
  const requesting: DesktopPermissionsState = { fullDiskAccessPermission: { status: "requesting" }, screenCapturePermission: { status: "denied" }, accessibilityPermission: { status: "granted" } }
  const granted: DesktopPermissionsState = { ...requesting, fullDiskAccessPermission: { status: "granted" } }
  let event!: (event: DaemonEvent) => void
  let respond!: (permissions: DesktopPermissionsState) => void
  const client = { closed: false, info: requesting, call: vi.fn(() => new Promise<DesktopPermissionsState>(resolve => { respond = resolve })), close: vi.fn() }
  mocks.connect.mockImplementation(async onEvent => { event = onEvent; return client })
  const changed = vi.fn()
  const connection = await createLocalAgentRuntime({ directory: "/daemon" }).connect(vi.fn(), changed)
  const response = action === "refresh" ? connection.refreshPermissions() : connection.requestPermission("fullDiskAccess")
  event({ kind: "desktopPermissionsChanged", permissions: granted })
  respond(requesting)
  expect(await response).toEqual(granted)
  expect(connection.desktopPermissions).toEqual(granted)
  expect(changed).toHaveBeenCalledExactlyOnceWith(granted)
})

function hosted() {
  let resolve!: () => void
  const closed = new Promise<void>(done => { resolve = done })
  return { closed, close: vi.fn(async () => { resolve(); await closed }), resolve }
}

test("desktop startup uses guided permission checks without automatic prompts", async () => {
  const daemon = hosted()
  mocks.startDaemon.mockResolvedValueOnce(daemon)
  const runtime = createLocalAgentRuntime({ directory: "/daemon" })
  await runtime.start()
  expect(mocks.startDaemon).toHaveBeenCalledExactlyOnceWith(0, { controlDirectory: "/daemon", permissionMode: "guided" })
  await runtime.close()
})

test("the app hosts the daemon in-process and closes it when quitting", async () => {
  const daemon = hosted()
  const start = vi.fn(async () => daemon)
  const runtime = createLocalAgentRuntime({ directory: "/daemon", start })
  await runtime.start()
  expect(start).toHaveBeenCalledExactlyOnceWith("/daemon")
  await runtime.close()
  expect(daemon.close).toHaveBeenCalledOnce()
  await runtime.close()
  expect(daemon.close).toHaveBeenCalledOnce()
})

test("a remote shutdown of the hosted daemon is awaited and lets it start again", async () => {
  const first = hosted()
  const second = hosted()
  const start = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
  const runtime = createLocalAgentRuntime({ directory: "/daemon", start })
  await runtime.start()
  const waiting = runtime.waitForShutdown()
  first.resolve()
  await waiting
  await runtime.start()
  await runtime.close()
  expect(first.close).not.toHaveBeenCalled()
  expect(second.close).toHaveBeenCalledOnce()
})
