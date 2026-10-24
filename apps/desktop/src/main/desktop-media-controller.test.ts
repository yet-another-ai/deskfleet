import { afterEach, expect, test, vi } from "vitest"
import type { DaemonEvent } from "../../../daemon/src/control-protocol.ts"

const mock = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock("./daemon-client.ts", () => ({ DaemonClient: { connect: mock.connect } }))
import { DesktopMediaController } from "./desktop-media-controller.ts"

const controllers: DesktopMediaController[] = []
afterEach(() => {
  for (const controller of controllers) controller.dispose()
  controllers.length = 0
  mock.connect.mockReset()
})

function fixture() {
  let event: (value: DaemonEvent) => void = () => {}
  let disconnect: (value: Error) => void = () => {}
  const client = {
    closed: false,
    info: { name: "actual-machine", desktop: true },
    call: vi.fn().mockResolvedValue({ sdp: "answer" }),
    close: vi.fn(),
  }
  mock.connect.mockImplementation((onEvent, onDisconnect) => {
    event = onEvent
    disconnect = onDisconnect
    return Promise.resolve(client)
  })
  const emit = vi.fn()
  const emitTerminal = vi.fn()
  const emitCatalog = vi.fn()
  const controller = new DesktopMediaController(emit, emitTerminal, emitCatalog)
  controllers.push(controller)
  return { controller, client, emit, emitTerminal, emitCatalog, event: (value: DaemonEvent) => event(value), disconnect: () => disconnect(new Error("daemon stopped")) }
}

const offer = { sessionId: "first", codec: "h264", audio: false, sdp: "offer" }

test("agent configuration validates requests and forwards dynamic agent options", async () => {
  const { controller, client } = fixture()
  await expect(controller.invoke("agentConfiguration", { provider: "codex", model: 42 })).rejects.toThrow("Invalid agent model")
  expect(mock.connect).not.toHaveBeenCalled()

  const configuration = {
    provider: { id: "codex", name: "Codex" },
    models: { id: "model", currentValue: "agent-model", options: [{ id: "agent-model", name: "Agent model" }] },
    reasoningEfforts: { id: "reasoning_effort", currentValue: "high", options: [{ id: "high", name: "High" }] },
  }
  client.call.mockResolvedValue(configuration)
  const params = { provider: "codex", worktreeId: "1", model: "agent-model", reasoningEffort: "high" }
  await expect(controller.invoke("agentConfiguration", params)).resolves.toEqual(configuration)
  expect(client.call).toHaveBeenCalledExactlyOnceWith("agentConfiguration", params)
  expect(client.close).toHaveBeenCalledTimes(1)
})

test("slow agent discovery has a separate connection and closes when its window is disposed", async () => {
  const { controller, client } = fixture()
  let reject!: (error: Error) => void
  const discovery = new Promise((_, fail) => { reject = fail })
  const configurationClient = {
    call: vi.fn().mockReturnValue(discovery),
    close: vi.fn(() => reject(new Error("Desktop connection closed"))),
  }
  mock.connect.mockResolvedValueOnce(configurationClient).mockResolvedValueOnce(client)
  const pending = controller.invoke("agentConfiguration", { provider: "codex" })

  await expect(controller.invoke("catalogList", {})).resolves.toEqual({ sdp: "answer" })
  expect(configurationClient.call).toHaveBeenCalledExactlyOnceWith("agentConfiguration", { provider: "codex" })
  expect(client.call).toHaveBeenCalledExactlyOnceWith("catalogList", {})
  expect(configurationClient.close).not.toHaveBeenCalled()
  const rejected = expect(pending).rejects.toThrow("Desktop connection closed")
  controller.dispose()
  await rejected
  expect(configurationClient.close).toHaveBeenCalledTimes(1)
  expect(client.close).toHaveBeenCalledTimes(1)
})

test("agent discovery closes a connection that arrives after window disposal", async () => {
  const { controller, client } = fixture()
  let resolve!: (value: typeof client) => void
  mock.connect.mockReturnValue(new Promise((res) => { resolve = res }))
  const pending = controller.invoke("agentConfiguration", { provider: "codex" })
  const rejected = expect(pending).rejects.toThrow("cancelled")
  controller.dispose()
  resolve(client)
  await rejected
  expect(client.close).toHaveBeenCalledTimes(1)
  expect(client.call).not.toHaveBeenCalled()
})

test("catalog operations share authenticated signaling without creating a peer", async () => {
  const { controller, client } = fixture()
  const directories = [{ path: "/code/frontend" }]
  const operations = [
    ["catalogList", {}],
    ["workspaceCreate", { name: "storefront", directories }],
    ["workspaceUpdate", { workspaceId: "1", name: "shop", directories }],
    ["workspaceDelete", { workspaceId: "1" }],
  ] as const

  for (const [method, params] of operations) {
    await controller.invoke(method, params)
    expect(client.call).toHaveBeenLastCalledWith(method, params)
  }
  expect(mock.connect).toHaveBeenCalledTimes(1)
  await expect(controller.invoke("workspaceUpdate", { workspaceId: "../other", name: "shop", directories })).rejects.toThrow("Invalid catalog resource ID")
  await expect(controller.invoke("workspaceCreate", { name: "main", directories: [] })).rejects.toThrow("A workspace needs at least one directory")
  await expect(controller.invoke("worktreeDelete", { worktreeId: "2" })).rejects.toThrow("Unknown desktop operation")
  expect(client.call).toHaveBeenCalledTimes(operations.length)
})

test("catalog changes have their own event stream and stop after owner disposal", async () => {
  const { controller, event, emit, emitTerminal, emitCatalog } = fixture()
  await controller.invoke("catalogList", {})
  event({ kind: "catalogChanged" })
  expect(emitCatalog).toHaveBeenCalledTimes(1)
  expect(emit).not.toHaveBeenCalled()
  expect(emitTerminal).not.toHaveBeenCalled()

  event({ kind: "terminalHungup", terminalId: "shell-1" })
  expect(emitCatalog).toHaveBeenCalledTimes(1)
  expect(emitTerminal).toHaveBeenCalledTimes(1)
  controller.dispose()
  event({ kind: "catalogChanged" })
  expect(emitCatalog).toHaveBeenCalledTimes(1)
})

test("dial and hangup use authenticated signaling even without a data peer", async () => {
  const { controller, client, event, emitTerminal, emit } = fixture()
  const dial = { mode: "create", terminalId: "shell-1", cols: 80, rows: 24 }
  await controller.invoke("terminalDial", dial)
  expect(client.call).toHaveBeenLastCalledWith("terminalDial", dial)
  await controller.invoke("terminalHangup", { terminalId: "shell-1" })
  expect(client.call).toHaveBeenLastCalledWith("terminalHangup", { terminalId: "shell-1" })
  event({ kind: "terminalHungup", terminalId: "shell-1" })
  expect(emitTerminal).toHaveBeenCalledWith({ kind: "terminalHungup", terminalId: "shell-1" })
  expect(emit).not.toHaveBeenCalled()
  await expect(controller.invoke("terminalDial", { ...dial, cols: 0 })).rejects.toThrow("terminal cols")
  await expect(controller.invoke("terminalHangup", { terminalId: "../other" })).rejects.toThrow("session ID")
})

test("terminal signaling reuses per-window peer ownership without requiring media settings", async () => {
  const { controller, client, event, emit } = fixture()
  const terminalOffer = { sessionId: "terminal-peer", sdp: "data-only-offer" }
  await controller.invoke("terminalOffer", terminalOffer)
  expect(client.call).toHaveBeenCalledWith("terminalOffer", terminalOffer)
  event({ sessionId: "terminal-peer", kind: "stateChanged", state: "connected" })
  expect(emit).toHaveBeenCalledWith({ sessionId: "terminal-peer", kind: "stateChanged", state: "connected" })
  await expect(controller.invoke("offer", { ...offer, sessionId: "terminal-peer" })).rejects.toThrow("already exists")
  await expect(controller.invoke("input", { sessionId: "terminal-peer", data: "input" })).rejects.toThrow("Unknown desktop operation")
  await controller.invoke("close", { sessionId: "terminal-peer" })
  expect(client.call).toHaveBeenLastCalledWith("close", { sessionId: "terminal-peer" })
})

test("a renderer can operate only on its own desktop sessions", async () => {
  const { controller, client, event, emit } = fixture()
  await expect(controller.invoke("start", { sessionId: "other", displayId: 1 })).rejects.toThrow("not owned")
  await controller.invoke("offer", offer)
  event({ sessionId: "other", kind: "error", error: "unrelated" })
  event({ sessionId: "first", kind: "stateChanged", state: "connected" })
  expect(emit).toHaveBeenCalledTimes(1)
  await expect(controller.invoke("offer", offer)).rejects.toThrow("already exists")
  await controller.invoke("close", { sessionId: "other" })
  expect(client.call).toHaveBeenCalledTimes(1)
  await controller.invoke("close", { sessionId: "first" })
  expect(client.call).toHaveBeenLastCalledWith("close", { sessionId: "first" })
})

test("a daemon disconnect reports active sessions and next discovery reconnects", async () => {
  const { controller, emit, disconnect } = fixture()
  await controller.invoke("offer", offer)
  disconnect()
  expect(emit).toHaveBeenCalledWith({ sessionId: "first", kind: "error", error: "daemon stopped" })
  await expect(controller.invoke("candidate", { sessionId: "first", candidate: { candidate: "" } })).rejects.toThrow("not owned")
  await expect(controller.invoke("target", undefined)).resolves.toMatchObject({ id: "local-daemon", name: "actual-machine", online: true })
  expect(mock.connect).toHaveBeenCalledTimes(2)
})

test("closing a window during discovery closes the late connection without creating a peer", async () => {
  const { controller, client } = fixture()
  let resolve!: (value: typeof client) => void
  mock.connect.mockReturnValue(new Promise((res) => { resolve = res }))
  const pending = controller.invoke("offer", offer)
  const rejected = expect(pending).rejects.toThrow("cancelled")
  controller.dispose()
  resolve(client)
  await rejected
  expect(client.close).toHaveBeenCalledTimes(1)
  expect(client.call).not.toHaveBeenCalled()
})

test("cancelling during discovery does not create the reserved peer", async () => {
  const { controller, client } = fixture()
  let resolve!: (value: typeof client) => void
  mock.connect.mockReturnValue(new Promise((res) => { resolve = res }))
  const pending = controller.invoke("offer", offer)
  const rejected = expect(pending).rejects.toThrow("cancelled")
  const closing = controller.invoke("close", { sessionId: "first" })
  resolve(client)
  await rejected
  await closing
  expect(client.call).not.toHaveBeenCalledWith("offer", expect.anything())
})
