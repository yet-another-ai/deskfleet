import { afterEach, expect, test, vi } from "vitest"
import type { DaemonEvent } from "../../../daemon/src/control-protocol.ts"
import { createLocalAgentRuntime } from "./local-agent-runtime.ts"

const mocks = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock("@deskfleet/daemon/control-client", () => ({ DaemonClient: { connect: mocks.connect } }))
vi.mock("@deskfleet/daemon", () => ({ startDaemon: vi.fn() }))
afterEach(() => vi.clearAllMocks())

test("connection retains both permission outcomes received alongside its initial handshake", async () => {
  let event!: (event: DaemonEvent) => void
  const client = {
    closed: false,
    info: { name: "machine", desktop: true, screenCapturePermission: { status: "requesting" }, accessibilityPermission: { status: "requesting" } },
    call: vi.fn(),
    close: vi.fn(),
  }
  mocks.connect.mockImplementation(async onEvent => {
    event = onEvent
    event({ kind: "desktopPermissionsChanged", permissions: { screenCapturePermission: { status: "granted" }, accessibilityPermission: { status: "requesting" } } })
    return client
  })
  const changed = vi.fn()
  const runtime = createLocalAgentRuntime({ directory: "/daemon", start: vi.fn() })
  const connection = await runtime.connect(vi.fn(), changed)
  expect(connection.desktopPermissions).toEqual({ screenCapturePermission: { status: "granted" }, accessibilityPermission: { status: "requesting" } })
  expect(changed).toHaveBeenCalledExactlyOnceWith(connection.desktopPermissions)
  event({ kind: "catalogChanged" })
  expect(changed).toHaveBeenCalledTimes(1)
  event({ kind: "desktopPermissionsChanged", permissions: { screenCapturePermission: { status: "granted" }, accessibilityPermission: { status: "denied" } } })
  expect(changed).toHaveBeenLastCalledWith({ screenCapturePermission: { status: "granted" }, accessibilityPermission: { status: "denied" } })
  expect(connection.desktopPermissions).toEqual({ screenCapturePermission: { status: "granted" }, accessibilityPermission: { status: "denied" } })
})

test("connecting to an existing daemon reads both permissions without starting another request", async () => {
  const client = {
    closed: false,
    info: { name: "machine", desktop: true, screenCapturePermission: { status: "denied" }, accessibilityPermission: { status: "granted" } },
    call: vi.fn(),
    close: vi.fn(),
  }
  mocks.connect.mockResolvedValue(client)
  const runtime = createLocalAgentRuntime({ directory: "/daemon", start: vi.fn() })
  const connection = await runtime.connect(vi.fn(), vi.fn())
  expect(connection.desktopPermissions).toEqual({ screenCapturePermission: { status: "denied" }, accessibilityPermission: { status: "granted" } })
  expect(client.call).not.toHaveBeenCalled()
})

function hosted() {
  let resolve!: () => void
  const closed = new Promise<void>(done => { resolve = done })
  return { closed, close: vi.fn(async () => { resolve(); await closed }), resolve }
}

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
