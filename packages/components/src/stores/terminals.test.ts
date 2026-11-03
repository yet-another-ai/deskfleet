import { client as platformClient } from "@deskfleet/client/platform"
import { flushPromises } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { TerminalSessionEvent, TerminalSummary } from "../../../client/src/terminal.ts"
import { TerminalClient } from "../services/terminal-client.ts"
import { useTerminalsStore } from "./terminals.ts"
import { deferred, stubWebRtc, TestPeer } from "../test/desktop-media.ts"

const shell: TerminalSummary = { id: "shell-1", title: "home", cwd: "/home/user", cols: 80, rows: 24, status: "running" }
const stores: ReturnType<typeof useTerminalsStore>[] = []
let receive: (event: TerminalSessionEvent) => void

beforeEach(() => {
  setActivePinia(createPinia())
  vi.spyOn(platformClient.terminal, "onSessionEvent").mockImplementation((listener) => {
    receive = listener
    return () => {}
  })
})
afterEach(() => {
  for (const store of stores.splice(0)) store.$dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setup() {
  const store = useTerminalsStore()
  stores.push(store)
  return store
}

test("keeps relay recovery metadata for a failed attachment and clears it when transport closes", async () => {
  stubWebRtc()
  vi.spyOn(platformClient.terminal, "dial").mockResolvedValue(shell)
  vi.spyOn(platformClient.terminal, "offer").mockResolvedValue({ sdp: "answer" })
  vi.spyOn(platformClient.terminal, "close").mockResolvedValue()
  vi.spyOn(platformClient.terminal, "onEvent").mockReturnValue(() => {})
  const original = platformClient.terminal.connectionFailureReason
  platformClient.terminal.connectionFailureReason = () => "turn_quota_exhausted"
  try {
    const store = setup()
    const attachment = store.attach(shell.id, () => {})
    const failed = expect(attachment.ready).rejects.toMatchObject({ code: "turn_quota_exhausted" })
    await flushPromises()
    TestPeer.instances.at(-1)!.changeState("failed")
    await failed
    expect(store.relayDeniedReason).toBe("turn_quota_exhausted")
    store.closeTransport()
    expect(store.error).toBeNull()
    expect(store.relayDeniedReason).toBeUndefined()
  } finally { platformClient.terminal.connectionFailureReason = original }
})

test("Mux terminal status and relay failures stay scoped while a sibling remains connected", async () => {
  stubWebRtc()
  vi.spyOn(platformClient.terminal, "dial").mockImplementation(async options => ({ ...shell, id: options.terminalId }))
  vi.spyOn(platformClient.terminal, "offer").mockResolvedValue({ sdp: "answer" })
  vi.spyOn(platformClient.terminal, "close").mockResolvedValue()
  vi.spyOn(platformClient.terminal, "onEvent").mockReturnValue(() => {})
  vi.spyOn(platformClient.terminal, "list").mockRejectedValue(new Error("Catalog unavailable"))
  const originalReason = platformClient.terminal.connectionFailureReason
  const originalMultiplexed = platformClient.terminal.multiplexed
  platformClient.terminal.connectionFailureReason = () => "turn_quota_exhausted"
  platformClient.terminal.multiplexed = true
  try {
    const store = setup()
    const first = store.attach(shell.id, () => {})
    await flushPromises()
    const channel = TestPeer.instances[0]!.input as TestPeer["input"] & { onopen: () => void }
    channel.send.mockImplementation(data => {
      const request = JSON.parse(data) as { id?: number }
      if (request.id !== undefined) queueMicrotask(() => channel.onmessage?.({ data: JSON.stringify({ id: request.id, result: shell }) }))
    })
    channel.readyState = "open"
    channel.onopen()
    await first.ready
    await store.refresh()
    expect(store.error).toBe("Catalog unavailable")

    const second = store.attach("shell-2", () => {})
    const failed = expect(second.ready).rejects.toMatchObject({ code: "turn_quota_exhausted" })
    await flushPromises()
    expect(store.state).toBe("connected")
    expect(store.transportStatus("shell-2").state).toBe("connecting")
    TestPeer.instances[1]!.changeState("failed")
    await failed
    expect(store.state).toBe("connected")
    expect(store.transportStatus(shell.id)).toEqual({ state: "connected", error: null, relayDeniedReason: undefined })
    expect(store.transportStatus("shell-2")).toMatchObject({ state: "error", relayDeniedReason: "turn_quota_exhausted" })
    expect(store.error).toBe("Catalog unavailable")
    expect(store.relayDeniedReason).toBeUndefined()
    second.detach()
    expect(store.state).toBe("connected")
    first.detach()
    expect(store.state).toBe("idle")
  } finally {
    platformClient.terminal.connectionFailureReason = originalReason
    platformClient.terminal.multiplexed = originalMultiplexed
  }
})

test("lists, dials and hangs up shells through signaling without needing a data peer", async () => {
  const list = vi.spyOn(platformClient.terminal, "list").mockResolvedValue([shell])
  const dial = vi.spyOn(platformClient.terminal, "dial").mockImplementation(async (options) => ({ ...shell, id: options.terminalId }))
  const hangup = vi.spyOn(platformClient.terminal, "hangup").mockResolvedValue()
  const offer = vi.spyOn(platformClient.terminal, "offer")
  const store = setup()
  expect(store.loaded).toBe(false)
  await store.refresh()
  expect(list).toHaveBeenCalledOnce()
  expect(store.loaded).toBe(true)
  expect(store.sessions).toEqual([shell])
  const created = await store.create({ cols: 100, rows: 40 })
  expect(dial).toHaveBeenCalledWith({ mode: "create", terminalId: created.id, cols: 100, rows: 40 })
  const owned = await store.create({ worktreeId: "31" })
  expect(dial).toHaveBeenLastCalledWith({ mode: "create", terminalId: owned.id, cols: 80, rows: 24, worktreeId: "31" })
  expect(store.selected["31"]).toBe(owned.id)
  await store.hangup(owned.id)
  expect(created.id).not.toBe(shell.id)
  await store.hangup(created.id)
  expect(hangup).toHaveBeenCalledWith(created.id)
  expect(store.sessions).toEqual([shell])
  expect(offer).not.toHaveBeenCalled()
})

test("catalog changes from another client update and remove only the matching shell", () => {
  const store = setup()
  receive({ kind: "terminalChanged", terminal: shell })
  receive({ kind: "terminalChanged", terminal: { ...shell, id: "shell-2" } })
  receive({ kind: "terminalChanged", terminal: { ...shell, status: "interrupted" } })
  expect(store.sessions.map(({ id, status }) => [id, status])).toEqual([["shell-1", "interrupted"], ["shell-2", "running"]])
  receive({ kind: "terminalHungup", terminalId: "shell-1" })
  expect(store.sessions.map(({ id }) => id)).toEqual(["shell-2"])
})

test("opening an empty panel first discovers existing shells and shares pending creation on reopen", async () => {
  const listed = deferred<TerminalSummary[]>()
  const list = vi.spyOn(platformClient.terminal, "list").mockReturnValueOnce(listed.promise).mockResolvedValue([])
  const created = deferred<TerminalSummary>()
  const dial = vi.spyOn(platformClient.terminal, "dial").mockReturnValue(created.promise)
  const store = setup()
  const opening = store.ensureWorktreeTerminal("31")
  expect(dial).not.toHaveBeenCalled()
  listed.resolve([{ ...shell, worktreeId: "31" }])
  await expect(opening).resolves.toMatchObject({ id: shell.id })
  expect(dial).not.toHaveBeenCalled()

  const first = store.ensureWorktreeTerminal("32")
  await vi.waitFor(() => expect(dial).toHaveBeenCalledOnce())
  const reopened = store.ensureWorktreeTerminal("32")
  created.resolve({ ...shell, id: "new-shell", worktreeId: "32" })
  await expect(first).resolves.toMatchObject({ id: "new-shell" })
  await expect(reopened).resolves.toMatchObject({ id: "new-shell" })
  expect(dial).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ worktreeId: "32" }))
  expect(list).toHaveBeenCalledTimes(2)
})

test("an unavailable terminal list leaves panel creation retryable without spawning a duplicate", async () => {
  const list = vi.spyOn(platformClient.terminal, "list").mockRejectedValue(new Error("Daemon unavailable"))
  const dial = vi.spyOn(platformClient.terminal, "dial")
  const store = setup()
  await expect(store.ensureWorktreeTerminal("31")).rejects.toThrow("Daemon unavailable")
  expect(store.loaded).toBe(false)
  expect(dial).not.toHaveBeenCalled()
  list.mockResolvedValue([{ ...shell, worktreeId: "31" }])
  await expect(store.ensureWorktreeTerminal("31")).resolves.toMatchObject({ id: shell.id })
  expect(store.loaded).toBe(true)
  expect(dial).not.toHaveBeenCalled()
})

test("opening a user shell does not reuse an agent-owned terminal in the same Worktree", async () => {
  const agentTerminal: TerminalSummary = { ...shell, id: "agent-command", worktreeId: "31", kind: "acp" }
  vi.spyOn(platformClient.terminal, "list").mockResolvedValue([agentTerminal])
  const dial = vi.spyOn(platformClient.terminal, "dial").mockImplementation(async options => ({ ...shell, id: options.terminalId, worktreeId: "31" }))
  const store = setup()
  const opened = await store.ensureWorktreeTerminal("31")
  expect(opened.id).not.toBe(agentTerminal.id)
  expect(dial).toHaveBeenCalledWith(expect.objectContaining({ mode: "create", worktreeId: "31" }))
  expect(store.sessions).toContainEqual(agentTerminal)
})

test("a shell announced during a shared list request prevents automatic duplicate creation", async () => {
  const listed = deferred<TerminalSummary[]>()
  const list = vi.spyOn(platformClient.terminal, "list").mockReturnValue(listed.promise)
  const dial = vi.spyOn(platformClient.terminal, "dial")
  const store = setup()
  const refreshing = store.refresh()
  const opening = store.ensureWorktreeTerminal("31")
  const existing = { ...shell, worktreeId: "31" }
  receive({ kind: "terminalChanged", terminal: existing })
  listed.resolve([])

  await refreshing
  await expect(opening).resolves.toEqual(existing)
  expect(store.sessions).toEqual([existing])
  expect(list).toHaveBeenCalledOnce()
  expect(dial).not.toHaveBeenCalled()
})

test("a stale list preserves the latest terminal update and does not restore a hung-up shell", async () => {
  const listed = deferred<TerminalSummary[]>()
  vi.spyOn(platformClient.terminal, "list").mockReturnValue(listed.promise)
  const store = setup()
  const refreshing = store.refresh()
  receive({ kind: "terminalChanged", terminal: { ...shell, status: "interrupted" } })
  const updated = { ...shell, title: "updated shell" }
  receive({ kind: "terminalChanged", terminal: updated })
  receive({ kind: "terminalChanged", terminal: { ...shell, id: "closed-shell" } })
  receive({ kind: "terminalHungup", terminalId: "closed-shell" })
  const unrelated = { ...shell, id: "other-shell" }
  listed.resolve([shell, { ...shell, id: "closed-shell" }, unrelated])

  await refreshing
  expect(store.sessions).toEqual([updated, unrelated])
})

test("local creation and hangup survive a list response even before their catalog events arrive", async () => {
  const listed = deferred<TerminalSummary[]>()
  vi.spyOn(platformClient.terminal, "list").mockReturnValue(listed.promise)
  vi.spyOn(platformClient.terminal, "dial").mockImplementation(async options => ({ ...shell, id: options.terminalId }))
  vi.spyOn(platformClient.terminal, "hangup").mockResolvedValue()
  const store = setup()
  const refreshing = store.refresh()
  const created = await store.create()
  await store.hangup(shell.id)
  listed.resolve([shell])

  await refreshing
  expect(store.sessions).toEqual([created])
})

test("reattaching dials the existing shell before using the data channel; detach does not hang up", async () => {
  const dial = vi.spyOn(platformClient.terminal, "dial").mockResolvedValue(shell)
  const hangup = vi.spyOn(platformClient.terminal, "hangup")
  const detach = vi.fn()
  vi.spyOn(TerminalClient.prototype, "subscribe").mockReturnValue(detach)
  const call = vi.spyOn(TerminalClient.prototype, "call").mockResolvedValue(shell)
  const store = setup()
  const attached = store.attach(shell.id, () => {})
  await attached.ready
  expect(dial).toHaveBeenCalledWith({ mode: "resume", terminalId: shell.id })
  expect(dial.mock.invocationCallOrder[0]).toBeLessThan(call.mock.invocationCallOrder[0]!)
  expect(call).toHaveBeenCalledWith("attach", { sessionId: shell.id })
  attached.detach()
  expect(detach).toHaveBeenCalledOnce()
  expect(hangup).not.toHaveBeenCalled()
})

test("a fast command's exit survives a stale attachment response", async () => {
  vi.spyOn(platformClient.terminal, "dial").mockResolvedValue(shell)
  vi.spyOn(TerminalClient.prototype, "subscribe").mockReturnValue(() => {})
  const attaching = deferred<TerminalSummary>()
  vi.spyOn(TerminalClient.prototype, "call").mockReturnValue(attaching.promise)
  const store = setup()
  const attached = store.attach(shell.id, () => {})
  await vi.waitFor(() => expect(store.sessions).toEqual([shell]))
  receive({ kind: "terminalChanged", terminal: { ...shell, status: "exited", exitCode: 0 } })
  attaching.resolve(shell)
  await expect(attached.ready).resolves.toMatchObject({ status: "exited", exitCode: 0 })
  expect(store.sessions).toEqual([{ ...shell, status: "exited", exitCode: 0 }])
})

test.each([false, true])("ordinary terminals use independent logical clients only for Mux: %s", async multiplexed => {
  const original = platformClient.terminal.multiplexed
  platformClient.terminal.multiplexed = multiplexed
  vi.spyOn(platformClient.terminal, "dial").mockImplementation(async options => ({ ...shell, id: options.terminalId }))
  const clients: TerminalClient[] = []
  vi.spyOn(TerminalClient.prototype, "subscribe").mockImplementation(function (this: TerminalClient) { clients.push(this); return () => {} })
  const calls: Array<{ client: TerminalClient; method: string }> = []
  vi.spyOn(TerminalClient.prototype, "call").mockImplementation(async function (this: TerminalClient, method) {
    calls.push({ client: this, method }); return shell as never
  })
  const close = vi.spyOn(TerminalClient.prototype, "close")
  try {
    const store = setup()
    const first = store.attach("one", () => {}), second = store.attach("two", () => {})
    await Promise.all([first.ready, second.ready])
    expect(new Set(clients).size).toBe(multiplexed ? 2 : 1)
    await store.resize("two", 100, 40)
    expect(calls.at(-1)).toEqual({ client: clients[1], method: "resize" })
    first.detach()
    expect(close).toHaveBeenCalledTimes(multiplexed ? 1 : 0)
    await store.resize("two", 120, 40)
    expect(calls.at(-1)!.client).toBe(clients[1])
    second.detach()
  } finally { platformClient.terminal.multiplexed = original }
})

test("stale attachment cleanup keeps the replacement Mux terminal attached", async () => {
  const original = platformClient.terminal.multiplexed
  platformClient.terminal.multiplexed = true
  vi.spyOn(platformClient.terminal, "dial").mockResolvedValue(shell)
  const clients: TerminalClient[] = []
  vi.spyOn(TerminalClient.prototype, "subscribe").mockImplementation(function (this: TerminalClient) { clients.push(this); return () => {} })
  const attaching = deferred<TerminalSummary>()
  const call = vi.spyOn(TerminalClient.prototype, "call").mockResolvedValue(shell).mockReturnValueOnce(attaching.promise)
  const close = vi.spyOn(TerminalClient.prototype, "close")
  try {
    const store = setup()
    const first = store.attach(shell.id, () => {})
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce())
    const second = store.attach(shell.id, () => {})
    await second.ready
    expect(clients[0]).toBe(clients[1])

    first.detach()
    expect(close).not.toHaveBeenCalled()
    attaching.resolve(shell)
    await expect(first.ready).rejects.toThrow("Terminal attachment was cancelled")
    expect(call).not.toHaveBeenCalledWith("detach", expect.anything())
    await store.resize(shell.id, 100, 40)
    expect(call.mock.instances.at(-1)).toBe(clients[1])
    second.detach()
    expect(close).toHaveBeenCalledOnce()
  } finally { platformClient.terminal.multiplexed = original }
})
