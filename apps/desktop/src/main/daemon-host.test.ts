import { beforeEach, expect, it, vi } from "vitest"
import { join } from "node:path"

const mocks = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  startDaemon: vi.fn(),
  createCodexProvider: vi.fn(() => ({ id: "codex" })),
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => "/desktop-app"),
    setPath: vi.fn(),
    setActivationPolicy: vi.fn(),
    whenReady: vi.fn<() => Promise<void>>(),
    on: vi.fn(),
    exit: vi.fn(),
  },
  powerMonitor: { on: vi.fn() },
}))

vi.mock("node:fs", () => ({ mkdirSync: mocks.mkdirSync }))
vi.mock("electron", () => ({ app: mocks.app, powerMonitor: mocks.powerMonitor }))
vi.mock("@deskfleet/daemon", () => ({ startDaemon: mocks.startDaemon, createCodexProvider: mocks.createCodexProvider }))
vi.mock("@deskfleet/daemon/control-discovery", () => ({ daemonControlDirectory: () => "/daemon-data" }))

import { startDaemonHost } from "./daemon-host.ts"

function pending() {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => { resolve = complete })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(process, "once").mockReturnValue(process)
})

it.each([false, true])("isolates Electron data, launches the bundled adapter, and waits for cleanup (packaged: %s)", async packaged => {
  mocks.app.isPackaged = packaged
  const ready = pending()
  const closed = pending()
  const close = vi.fn(() => closed.promise)
  mocks.app.whenReady.mockReturnValue(ready.promise)
  mocks.startDaemon.mockResolvedValue({ close, closed: closed.promise })

  startDaemonHost()

  const directory = join("/daemon-data", "electron-profile")
  expect(mocks.app.setPath.mock.calls).toEqual([["userData", directory], ["sessionData", directory]])
  expect(mocks.startDaemon).not.toHaveBeenCalled()
  ready.resolve()
  await vi.waitFor(() => expect(mocks.startDaemon).toHaveBeenCalledOnce())
  expect(mocks.createCodexProvider).toHaveBeenCalledWith({
    command: process.execPath,
    args: [...(packaged ? [] : ["/desktop-app"]), "--deskfleet-codex-acp"],
    env: { ELECTRON_RUN_AS_NODE: undefined },
  })
  expect(mocks.startDaemon).toHaveBeenCalledWith(0, { agentProvider: { id: "codex" } })

  const beforeQuit = mocks.app.on.mock.calls.find(([event]) => event === "before-quit")?.[1]
  const preventDefault = vi.fn()
  beforeQuit({ preventDefault })
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(mocks.app.exit).not.toHaveBeenCalled()

  closed.resolve()
  await vi.waitFor(() => expect(mocks.app.exit).toHaveBeenCalledWith(0))
})

it("exits with an error when the daemon cannot start", async () => {
  const error = new Error("Local daemon is already running")
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  mocks.app.whenReady.mockResolvedValue()
  mocks.startDaemon.mockRejectedValue(error)

  startDaemonHost()

  await vi.waitFor(() => expect(mocks.app.exit).toHaveBeenCalledWith(1))
  expect(log).toHaveBeenCalledWith(error)
})
